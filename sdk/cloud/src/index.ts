/**
 * Prismer Cloud SDK for TypeScript/JavaScript
 *
 * @example
 * ```typescript
 * import { PrismerClient } from '@prismer/sdk';
 *
 * const client = new PrismerClient({ apiKey: 'sk-prismer-...' });
 *
 * // Context API
 * const result = await client.load('https://example.com');
 *
 * // Parse API
 * const pdf = await client.parsePdf('https://arxiv.org/pdf/2401.00001.pdf');
 *
 * // IM API (sub-module pattern)
 * const reg = await client.im.account.register({ type: 'agent', username: 'my-agent', displayName: 'My Agent' });
 * await client.im.direct.send('user-123', 'Hello!');
 * const groups = await client.im.groups.list();
 * const convos = await client.im.conversations.list();
 * ```
 */

import { RealtimeWSClient, RealtimeSSEClient } from './realtime';
import type { RealtimeConfig } from './realtime';
import { OfflineManager } from './offline';
import { SandboxesClient } from './eaas-sandbox';
import { rememberRetryAfter } from './eaas-response-meta';
export { SandboxesClient, SandboxHandle, SandboxError } from './eaas-sandbox';
export type { SandboxCreateOptions, SandboxCommandResult } from './eaas-sandbox';
import { CommunityHub } from './community-hub';
import { AIPIdentity } from './aip';
import { EaasClientError, isEaasErrorEnvelope, newIdempotencyKey } from './environment-contract';
import type {
  EaasApiEnvelope,
  EaasExecReadView,
  EaasExecView,
  EaasFailEnvelope,
  EaasAnswerInput,
  EaasContentBlockInput,
  EaasFileGetResult,
  EaasFilePutView,
  EaasLifecycleResult,
  EaasServicesProjection,
  EaasSnapshotCreated,
  EaasSnapshotList,
  EaasUsagePage,
  EaasBillingPage,
  EaasConversationList,
  EaasConversationView,
  EaasCreatedPublishableKey,
  EaasIssuedAccessSession,
  EaasIssuedSession,
  EaasIssueAccessSessionBody,
  EaasIssueSessionBody,
  EaasMessageList,
  EaasAssetUploadResult,
  EaasPrincipalSessionList,
  EaasPrincipalSessionRevokeResult,
  EaasPublishableKeyList,
  EaasPublishableKeyRevokeResult,
  EaasRunCancelResult,
  EaasRunEventPage,
  EaasRunView,
  EaasSendMessageResult,
  EaasArtifactGetResult,
  EaasArtifactList,
  EaasEventReplayPage,
  EaasContextProjection,
  EaasPrivateSkillCreateBody,
  EaasMemoryWriteBody,
  EaasMemoryWriteResult,
  EaasMemorySearchResult,
  EaasMemoryGrantResult,
  EaasPrivateSkillDetail,
  EaasPrivateSkillList,
  EaasPrivateSkillUpdateBody,
  EaasPrivateSkillView,
  EaasSkillDeleteResult,
  EaasSkillPublishResult,
  EnvironmentCreateSpec,
  EnvironmentListPage,
  EnvironmentStatus,
  WarmPoolPolicy,
  WarmPoolStatus,
  PoolPolicyStatus,
  ProjectPoolManagement,
  ProjectPoolsPage,
} from './environment-contract';

// Node.js built-ins — optional (not available in browser environments)
//
// 经 process.getBuiltinModule（Node ≥20.16/22.3 官方运行时内建加载口）获取：
// 不出现 require/import 说明符，浏览器 bundler（turbopack/webpack/vite）无从
// 静态解析，客户端 bundle 可编译——裸 require('fs') 会在编译期直接
// "Module not found: Can't resolve 'fs'"（UIKit eaas-sdk 挂载实测）。浏览器与
// 无此 API 的旧运行时返回 null，config.toml fallback 照旧不可用（行为不变）。
function loadNodeBuiltins(): {
  fs: typeof import('fs');
  os: typeof import('os');
  path: typeof import('path');
} | null {
  const gbm = (
    globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }
  ).process?.getBuiltinModule;
  if (typeof gbm !== 'function') return null;
  try {
    return {
      fs: gbm('fs') as typeof import('fs'),
      os: gbm('os') as typeof import('os'),
      path: gbm('path') as typeof import('path'),
    };
  } catch {
    return null;
  }
}
const _node = loadNodeBuiltins();
const _fs: typeof import('fs') | null = _node?.fs ?? null;
const _os: typeof import('os') | null = _node?.os ?? null;
const _path: typeof import('path') | null = _node?.path ?? null;

/**
 * 运行时取 Node 内建句柄（fs/path/os）。调用点全部是 Node-only 分支（本地路径
 * 读写/插件安装），浏览器调用方走 Blob/bytes 分支不经过这里；不可用时抛错由
 * 调用点既有 try/catch 或调用方兜底。统一入口保证模块内不再出现任何
 * require/import 形态的 Node 说明符（浏览器 bundle 可编译，见 loadNodeBuiltins）。
 */
/** 泛型内建取用（fs/path/os 之外：crypto 等）——同样零说明符，浏览器返回 null。 */
function nodeBuiltin<T = unknown>(id: string): T | null {
  const g = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
    ?.getBuiltinModule;
  if (typeof g !== 'function') return null;
  try {
    return g(id) as T;
  } catch {
    return null;
  }
}

function requireNodeBuiltins(): { fs: typeof import('fs'); path: typeof import('path'); os: typeof import('os') } {
  if (!_fs || !_path || !_os) throw new Error('Node builtins unavailable in this runtime (browser)');
  return { fs: _fs, path: _path, os: _os };
}

/**
 * Resolve API key with priority chain:
 *   1. Explicit value passed to constructor
 *   2. PRISMER_API_KEY env var
 *   3. ~/.prismer/config.toml api_key
 *   4. '' (empty)
 */
function resolveApiKey(explicit?: string): string {
  if (explicit) return explicit;
  try {
    if (typeof process !== 'undefined' && process.env?.PRISMER_API_KEY) {
      return process.env.PRISMER_API_KEY;
    }
  } catch { /* ignore */ }
  if (_fs && _os && _path) {
    try {
      const configPath = _path.join(_os.homedir(), '.prismer', 'config.toml');
      const raw = _fs.readFileSync(configPath, 'utf-8');
      const match = raw.match(/^api_key\s*=\s*'([^']+)'/m) || raw.match(/^api_key\s*=\s*"([^"]+)"/m);
      if (match?.[1]) return match[1];
    } catch { /* file not found — that's OK */ }
  }
  return '';
}

/**
 * Resolve base URL with priority chain:
 *   1. Explicit value passed to constructor
 *   2. PRISMER_BASE_URL env var
 *   3. ~/.prismer/config.toml base_url
 *   4. undefined (caller uses environment default)
 */
function resolveBaseUrl(explicit?: string): string | undefined {
  if (explicit) return explicit;
  try {
    if (typeof process !== 'undefined' && process.env?.PRISMER_BASE_URL) {
      return process.env.PRISMER_BASE_URL;
    }
  } catch { /* ignore */ }
  if (_fs && _os && _path) {
    try {
      const configPath = _path.join(_os.homedir(), '.prismer', 'config.toml');
      const raw = _fs.readFileSync(configPath, 'utf-8');
      const match = raw.match(/^base_url\s*=\s*'([^']+)'/m) || raw.match(/^base_url\s*=\s*"([^"]+)"/m);
      if (match?.[1]) return match[1];
    } catch { /* file not found — that's OK */ }
  }
  return undefined;
}

// Re-export all types
export * from './types';
export * from './im/workspace/tasks';
export * from './im/workspace/assets';

// v1.9.x IM WS protocol (Track C) — kept in a separate sub-module to avoid
// colliding with names in `./types`. Consumers (e.g. runtime/ws-client) import
// daemon-protocol payloads from here.
export * from './types/im-events';

// EaaS tenant surface (eaas-gate-a Task 12) — contract mirror + event stream
// are also standalone subpaths (`@prismer/sdk/environment-contract` /
// `@prismer/sdk/environment-stream`); re-exported here for one-import UX.
export * from './environment-contract';
export { connectEaasEvents } from './environment-stream';
export type {
  EaasStreamOptions,
  EaasStreamHandle,
  EaasEventFilters,
  EaasResyncInfo,
  EaasStreamEndInfo,
} from './environment-stream';

export { AIPIdentity } from './aip';
export type { DIDDocument, SignedPayload } from './aip';
export {
  RealtimeWSClient,
  RealtimeSSEClient,
  type RealtimeConfig,
  type RealtimeState,
  type RealtimeCommand,
  type RealtimeEventMap,
  type RealtimeEventType,
  type AuthenticatedPayload,
  type MessageNewPayload,
  type MessageEditPayload,
  type MessageReactionPayload,
  type MessageDeletedPayload,
  type TypingIndicatorPayload,
  type PresenceChangedPayload,
  type PongPayload,
  type ErrorPayload,
  type DisconnectedPayload,
  type ReconnectingPayload,
} from './realtime';

/** Entry in the OpenAI-format model list returned by /api/v1/models. */
export interface ModelEntry {
  id: string;
  object: 'model';
  owned_by: string;
}

// Re-export storage and offline modules
export { MemoryStorage, IndexedDBStorage, SQLiteStorage } from './storage';
export type { StorageAdapter, StoredMessage, StoredConversation, StoredContact, OutboxOperation } from './storage';
export { OfflineManager, AttachmentQueue } from './offline';
export type { SyncEvent, SyncResult, OfflineEventMap, OfflineEventType, QueuedAttachment } from './offline';
export { TabCoordinator } from './multitab';
export { E2EEncryption } from './encryption';
export {
  encryptForSend,
  decryptOnReceive,
  encryptFile,
  decryptFile,
  encryptContext,
  decryptContext,
  decryptMessages,
  type EncryptedMessage,
  type DecryptResult,
  type EncryptedFileResult,
  type EncryptedContextResult,
} from './encryption-pipeline';

// Re-export evolution mechanism modules
export { EvolutionCache } from './evolution-cache';
export { extractSignals, createEnrichedExtractor } from './signal-enrichment';
export { EvolutionRuntime } from './evolution-runtime';
export type { EvolutionRuntimeConfig, Suggestion, EvolutionSession, SessionMetrics } from './evolution-runtime';
export type { GeneSelectionResult, EvolutionSyncSnapshot, EvolutionSyncDelta, ExecutionContext, SignalEnrichmentConfig } from './types';

import type {
  PrismerConfig,
  Environment,
  LoadOptions,
  LoadResult,
  SaveOptions,
  SaveBatchOptions,
  SaveResult,
  ParseOptions,
  ParseResult,
  IMRegisterOptions,
  IMRegisterData,
  IMMeData,
  IMTokenData,
  IMSendOptions,
  IMMessageData,
  IMPaginationOptions,
  IMMessage,
  IMCreateGroupOptions,
  IMGroupData,
  IMConversationsOptions,
  IMConversation,
  IMContact,
  IMExternalContact,
  IMExternalContactsView,
  IMFriendRequest,
  IMBlockedUser,
  IMUserProfile,
  IMDiscoverOptions,
  IMDiscoverAgent,
  IMAgentDiscoverOptions,
  IMAgentCatalogEntry,
  IMCreateBindingOptions,
  IMBindingData,
  IMBinding,
  IMCreditsData,
  IMTransaction,
  IMWorkspaceData,
  IMWorkspaceInitOptions,
  IMWorkspaceInitGroupOptions,
  IMWorkspaceCreateAgentOptions,
  IMAutocompleteResult,
  IMPresignOptions,
  IMPresignResult,
  IMConfirmResult,
  IMFileQuota,
  FileInput,
  UploadOptions,
  UploadResult,
  SendFileOptions,
  SendFileResult,
  IMMultipartInitResult,
  IMResult,
  RequestFn,
  RequestOpts,
  // v2.0 §4.6 ContentBlock + ChatMessage + TaskInput
  ContentBlock,
  ContentBlockInput,
  ContentBlockOutput,
  ContentBlockText,
  ContentBlockImage,
  ContentBlockAudio,
  ContentBlockVideo,
  ContentBlockFile,
  ContentBlockToolUse,
  ContentBlockToolResult,
  ContentBlockToolResultInput,
  ContentBlockToolResultOutput,
  ContentBlockReasoning,
  ContentBlockPkf,
  ContentBlockPkfInput,
  ContentBlockPkfOutput,
  ChatMessage,
  TaskInput,
  PkfApiEnvelope,
  PkfCarrierMaterializeRequest,
  PkfCarrierMaterializationView,
  PkfMaterializationDiscoveryQuery,
  PkfMaterializationReadQuery,
  PkfBundleCommitRequest,
  PkfBundleReadQuery,
  PkfBundleCommitView,
  PkfArtifactRelationsQuery,
  PkfArtifactGraphView,
  PkfResourceReadQuery,
  PkfResourceDetailView,
  ImageMime,
  AudioMime,
  VideoMime,
  // Tasks
  IMCreateTaskOptions,
  IMUpdateTaskOptions,
  IMTaskListOptions,
  IMCompleteTaskOptions,
  IMTask,
  IMTaskDetail,
  IMTaskResult,
  // Memory
  IMCreateMemoryFileOptions,
  IMUpdateMemoryFileOptions,
  IMCompactOptions,
  IMMemoryFile,
  IMMemoryFileDetail,
  IMCompactionSummary,
  IMMemoryLoadResult,
  // Cross-workspace memory grants + external recall (memory211/05 W3)
  IMMemoryGrant,
  IMMemoryGrantStatus,
  IMMemoryGrantCreateOptions,
  IMMemoryGrantListOptions,
  IMMemoryExternalSearchOptions,
  IMMemoryExternalSearchResult,
  IMMemoryExternalLoadOptions,
  IMMemoryExternalLoadResult,
  // Knowledge Links
  KnowledgeLinkSource,
  KnowledgeLinkType,
  IMKnowledgeLink,
  IMMemoryKnowledgeLinks,
  // Identity
  IMRegisterKeyOptions,
  IMIdentityKey,
  IMKeyAuditEntry,
  IMKeyVerifyResult,
  // Evolution
  IMCreateGeneOptions,
  IMAnalyzeOptions,
  IMRecordOutcomeOptions,
  IMGene,
  IMAnalyzeResult,
  IMEvolutionStats,
  IMCapsule,
  IMEvolutionEdge,
  IMAgentPersonality,
  IMGeneListOptions,
  IMForkGeneOptions,
  // Skills
  IMSkillInfo,
  IMSkillSearchOptions,
  IMSkillCreateInput,
  IMSkillUpdateInput,
  IMSkillInstallResult,
  IMAgentSkillRecord,
  IMSkillContent,
  IMAgentSkillListOptions,
  IMAgentSkillInstallOptions,
  IMAgentSkillAckInput,
  IMAgentSpec,
  IMAgentSnapshot,
  IMAgentPack,
  IMAgentSnapshotOptions,
  IMAgentRestoreOptions,
  IMAgentPublishOptions,
  IMAgentPackListOptions,
  IMAgentForkOptions,
  IMAgentForkResult,
  // v1.9.3
  IMWorkspace,
  IMCreateWorkspaceOptions,
  IMUpdateWorkspaceOptions,
  IMWorkspaceSyncResult,
  IMWorkspaceOrchestrator,
  IMWorkspaceOrchestratorEnvelope,
  IMWorkspaceFile,
  IMCreateWorkspaceFileOptions,
  IMWorkspaceFileSyncResult,
  IMAsset,
  IMAssetListOptions,
  IMAssetUploadOptions,
  IMAssetDetail,
  IMRuntimeInstallation,
  IMCreateRuntimeInstallationOptions,
  IMPatchRuntimeInstallationOptions,
  IMInstallAgentOnRuntimeOptions,
  IMInstallAgentOnRuntimeResult,
  IMOwnedAgent,
  IMAccountDeleteResult,
  IMMemoryDigest,
  IMMemoryDigestOptions,
  TaskEventEnvelope,
  TaskEventType,
} from './types';

import { ENVIRONMENTS } from './types';

// ============================================================================
// v2.0 §3.0.2 helpers — idempotency key + send-body builder
// ============================================================================

/**
 * Generate an idempotency key. Prefers `crypto.randomUUID()` (Node 19+,
 * browsers, Deno, Bun); falls back to a Math.random-based UUIDv4 shim for
 * exotic runtimes where `crypto.randomUUID` is missing.
 *
 * Server applies UNIQUE (conversationId, idempotencyKey) — same key across
 * retries triggers server-side dedup (see migration 401).
 */
function generateIdempotencyKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* fall through to shim */ }
  // RFC 4122 v4 fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Build the JSON body for POST /api/im/messages/:cid + the per-call
 * `RequestOpts` carrying the `X-Idempotency-Key` header. Shared by
 * MessagesClient, DirectClient, GroupsClient.
 *
 * Returns `{ body, opts, key }` so call sites can stamp the same key into
 * retry attempts.
 */
function buildSendPayload(
  content: string | ContentBlockInput[],
  options?: IMSendOptions,
): { body: Record<string, unknown>; opts: RequestOpts; key: string } {
  const key = options?.idempotencyKey ?? generateIdempotencyKey();
  const isBlocks = Array.isArray(content);
  const body: Record<string, unknown> = {
    // For ContentBlock[] inputs, populate `content` as a fallback summary
    // (server's legacy `content` column stays compatible during the 6-sprint
    // double-write window from §4.6); the SOT is `contentBlocks`.
    content: isBlocks ? '' : (content as string),
    type: options?.type ?? 'text',
    metadata: options?.metadata,
    attachments: options?.attachments,
    parentId: options?.parentId,
    quotedMessageId: options?.quotedMessageId,
    idempotencyKey: key,
  };
  if (isBlocks) {
    body.contentBlocks = content;
  } else if (options?.contentBlocks) {
    body.contentBlocks = options.contentBlocks;
  }
  return {
    body,
    opts: { headers: { 'X-Idempotency-Key': key } },
    key,
  };
}

// ============================================================================
// IM Sub-Clients
// ============================================================================

/** Account management: register, identity, token refresh */
export class AccountClient {
  constructor(private _r: RequestFn) {}

  /** Register an agent or human identity */
  async register(options: IMRegisterOptions): Promise<IMResult<IMRegisterData>> {
    return this._r('POST', '/api/im/register', options);
  }

  /** Get own identity, stats, bindings, credits */
  async me(): Promise<IMResult<IMMeData>> {
    return this._r('GET', '/api/im/me');
  }

  /** Update own profile */
  async updateProfile(options: {
    displayName?: string;
    avatarUrl?: string;
    metadata?: Record<string, any>;
  }): Promise<IMResult<IMMeData>> {
    return this._r('PATCH', '/api/im/me', options);
  }

  /** Refresh JWT token */
  async refreshToken(): Promise<IMResult<IMTokenData>> {
    return this._r('POST', '/api/im/token/refresh');
  }

  /**
   * List agents owned by the current human user (v1.9.3).
   * Mobile clients call this on launch to populate the Profile/agent runtime card.
   * Returns `[]` for non-human / api-key-proxy callers without a cloudUserId.
   */
  async listAgents(): Promise<IMResult<IMOwnedAgent[]>> {
    return this._r('GET', '/api/im/me/agents');
  }

  /**
   * Self-service account deletion (v1.9.3).
   * Soft-deletes the IMUser, cascades owned conversations + open tasks,
   * revokes pc_api_keys, and blacklists the request token.
   * The caller can only delete themselves — there is no target id parameter.
   */
  async deleteAccount(): Promise<IMResult<IMAccountDeleteResult>> {
    return this._r('DELETE', '/api/im/me');
  }
}

/** Direct messaging between two users */
export class DirectClient {
  constructor(private _r: RequestFn) {}

  /**
   * Send a direct message to a user.
   *
   * v2.0 §4.6 — `content` may now be a `ContentBlock[]` for multimodal sends.
   * v2.0 §3.0.2 Gap A-④ — when `options.idempotencyKey` is omitted, the SDK
   * generates a UUID per call and stamps it into the `X-Idempotency-Key`
   * header. Pass the same key across retries to trigger server dedup.
   */
  async send(userId: string, content: string | ContentBlockInput[], options?: IMSendOptions): Promise<IMResult<IMMessageData>> {
    const { body, opts } = buildSendPayload(content, options);
    return this._r('POST', `/api/im/direct/${userId}/messages`, body, undefined, opts);
  }

  /** Get direct message history with a user */
  async getMessages(userId: string, options?: IMPaginationOptions): Promise<IMResult<IMMessage[]>> {
    const query: Record<string, string> = {};
    if (options?.limit != null) query.limit = String(options.limit);
    if (options?.offset != null) query.offset = String(options.offset);
    return this._r('GET', `/api/im/direct/${userId}/messages`, undefined, query);
  }
}

/** Group chat management and messaging */
export class GroupsClient {
  constructor(private _r: RequestFn) {}

  /** Create a group chat */
  async create(options: IMCreateGroupOptions): Promise<IMResult<IMGroupData>> {
    return this._r('POST', '/api/im/groups', options);
  }

  /** List groups you belong to */
  async list(): Promise<IMResult<IMGroupData[]>> {
    return this._r('GET', '/api/im/groups');
  }

  /** Get group details */
  async get(groupId: string): Promise<IMResult<IMGroupData>> {
    return this._r('GET', `/api/im/groups/${groupId}`);
  }

  /**
   * Send a message to a group.
   *
   * v2.0 §4.6 — `content` may now be a `ContentBlock[]` for multimodal sends.
   * v2.0 §3.0.2 Gap A-④ — auto-generates `X-Idempotency-Key` per call.
   */
  async send(groupId: string, content: string | ContentBlockInput[], options?: IMSendOptions): Promise<IMResult<IMMessageData>> {
    const { body, opts } = buildSendPayload(content, options);
    return this._r('POST', `/api/im/groups/${groupId}/messages`, body, undefined, opts);
  }

  /** Get group message history */
  async getMessages(groupId: string, options?: IMPaginationOptions): Promise<IMResult<IMMessage[]>> {
    const query: Record<string, string> = {};
    if (options?.limit != null) query.limit = String(options.limit);
    if (options?.offset != null) query.offset = String(options.offset);
    return this._r('GET', `/api/im/groups/${groupId}/messages`, undefined, query);
  }

  /** Add a member to a group (owner/admin only) */
  async addMember(groupId: string, userId: string): Promise<IMResult<void>> {
    return this._r('POST', `/api/im/groups/${groupId}/members`, { userId });
  }

  /** Remove a member from a group (owner/admin only) */
  async removeMember(groupId: string, userId: string): Promise<IMResult<void>> {
    return this._r('DELETE', `/api/im/groups/${groupId}/members/${userId}`);
  }
}

/** Conversation management */
export class ConversationsClient {
  constructor(private _r: RequestFn) {}

  /** List conversations */
  async list(options?: IMConversationsOptions): Promise<IMResult<IMConversation[]>> {
    const query: Record<string, string> = {};
    if (options?.withUnread) query.withUnread = 'true';
    if (options?.unreadOnly) query.unreadOnly = 'true';
    return this._r('GET', '/api/im/conversations', undefined, query);
  }

  /** Get conversation details */
  async get(conversationId: string): Promise<IMResult<IMConversation>> {
    return this._r('GET', `/api/im/conversations/${conversationId}`);
  }

  /** Create a direct conversation */
  async createDirect(userId: string): Promise<IMResult<IMConversation>> {
    return this._r('POST', '/api/im/conversations/direct', { userId });
  }

  /** Mark a conversation as read */
  async markAsRead(conversationId: string): Promise<IMResult<void>> {
    return this._r('POST', `/api/im/conversations/${conversationId}/read`);
  }

  /** Archive a conversation */
  async archive(conversationId: string): Promise<IMResult<void>> {
    return this._r('POST', `/api/im/conversations/${conversationId}/archive`);
  }

  /** Unarchive a conversation */
  async unarchive(conversationId: string): Promise<IMResult<void>> {
    return this._r('POST', `/api/im/conversations/${conversationId}/unarchive`);
  }

  /** Update conversation metadata */
  async update(conversationId: string, options: {
    title?: string;
    description?: string;
    metadata?: Record<string, any>;
  }): Promise<IMResult<IMConversation>> {
    return this._r('PATCH', `/api/im/conversations/${conversationId}`, options);
  }

  /** Pin or unpin a conversation */
  async pin(conversationId: string, pinned: boolean): Promise<IMResult<void>> {
    return this._r('PATCH', `/api/im/conversations/${conversationId}/pin`, { pinned });
  }

  /** Mute or unmute a conversation */
  async mute(conversationId: string, muted: boolean): Promise<IMResult<void>> {
    return this._r('PATCH', `/api/im/conversations/${conversationId}/mute`, { muted });
  }

  /** Delete a conversation */
  async delete(conversationId: string): Promise<IMResult<void>> {
    return this._r('DELETE', `/api/im/conversations/${conversationId}`);
  }
}

/** Low-level message operations (by conversation ID) */
export class MessagesClient {
  constructor(private _r: RequestFn) {}

  /**
   * Send a message to a conversation.
   *
   * v2.0 §4.6 — `content` may now be a `ContentBlock[]` for multimodal sends.
   * The SDK serialises ContentBlock[] into `body.contentBlocks` (preferred
   * path) while still writing a string `content` for legacy renderers during
   * the §4.6 6-sprint double-read window.
   *
   * v2.0 §3.0.2 Gap A-④ — when `options.idempotencyKey` is omitted, the SDK
   * auto-generates `crypto.randomUUID()` per call and includes it as the
   * `X-Idempotency-Key` HTTP header. The server applies UNIQUE
   * `(conversationId, idempotencyKey)` dedup; pass the same key across
   * retries to safely re-send.
   */
  async send(conversationId: string, content: string | ContentBlockInput[], options?: IMSendOptions): Promise<IMResult<IMMessageData>> {
    const { body, opts } = buildSendPayload(content, options);
    return this._r('POST', `/api/im/messages/${conversationId}`, body, undefined, opts);
  }

  /** Get message history for a conversation */
  async getHistory(conversationId: string, options?: IMPaginationOptions): Promise<IMResult<IMMessage[]>> {
    const query: Record<string, string> = {};
    if (options?.limit != null) query.limit = String(options.limit);
    if (options?.offset != null) query.offset = String(options.offset);
    return this._r('GET', `/api/im/messages/${conversationId}`, undefined, query);
  }

  /** Edit a message */
  async edit(conversationId: string, messageId: string, content: string, options?: { metadata?: Record<string, any> }): Promise<IMResult<void>> {
    return this._r('PATCH', `/api/im/messages/${conversationId}/${messageId}`, { content, ...(options?.metadata ? { metadata: options.metadata } : {}) });
  }

  /** Delete a message */
  async delete(conversationId: string, messageId: string): Promise<IMResult<void>> {
    return this._r('DELETE', `/api/im/messages/${conversationId}/${messageId}`);
  }

  /** Mark messages as delivered */
  async markDelivered(conversationId: string, messageIds: string[]): Promise<IMResult<void>> {
    return this._r('POST', '/api/im/messages/delivered', { conversationId, messageIds });
  }

  /**
   * Add or remove an emoji reaction on a message (v1.8.2).
   * Idempotent — adding an existing reaction or removing a non-existent one is a no-op.
   * Returns the full reactions snapshot: `{ "👍": ["userId-a", ...], ... }`.
   */
  async react(
    conversationId: string,
    messageId: string,
    emoji: string,
    options?: { remove?: boolean },
  ): Promise<IMResult<{ reactions: Record<string, string[]> }>> {
    return this._r('POST', `/api/im/messages/${conversationId}/${messageId}/reactions`, {
      emoji,
      ...(options?.remove ? { remove: true } : {}),
    });
  }
}

/** Contacts and agent discovery */
export class ContactsClient {
  constructor(private _r: RequestFn) {}

  /** List contacts (users you've communicated with) */
  async list(): Promise<IMResult<IMContact[]>> {
    return this._r('GET', '/api/im/contacts');
  }

  /**
   * K 空腔闭合 — 外部联系人边自读（GET /me/external-contacts）。
   * agent 主体回自身 userId 的边；human 主体等价 roster.external。
   */
  async externalContacts(workspaceId: string): Promise<IMResult<IMExternalContactsView>> {
    return this._r('GET', '/api/im/me/external-contacts', undefined, { workspaceId });
  }

  /** Search users/agents by query */
  async search(query: string, options?: {
    type?: 'human' | 'agent' | 'all';
    limit?: number;
    offset?: number;
  }): Promise<IMResult<IMUserProfile[]>> {
    const params: Record<string, string> = { q: query };
    if (options?.type && options.type !== 'all') params.type = options.type;
    if (options?.limit) params.limit = String(options.limit);
    if (options?.offset) params.offset = String(options.offset);
    return this._r('GET', '/api/im/discover', undefined, params);
  }

  /** Get a user's public profile */
  async getProfile(userId: string): Promise<IMResult<IMUserProfile>> {
    return this._r('GET', `/api/im/users/${userId}`);
  }

  /** Discover agents by capability or type */
  async discover(options?: IMDiscoverOptions): Promise<IMResult<IMDiscoverAgent[]>> {
    const query: Record<string, string> = {};
    if (options?.type) query.type = options.type;
    if (options?.capability) query.capability = options.capability;
    if (options?.status) query.status = options.status;
    if (options?.onlineOnly) query.onlineOnly = options.onlineOnly;
    if (options?.q) query.q = options.q;
    if (options?.limit) query.limit = options.limit;
    if (options?.offset) query.offset = options.offset;
    return this._r('GET', '/api/im/discover', undefined, query);
  }

  // ─── Friend System (v1.8.0 P9) ─────────────────────────

  /** Send a friend request */
  async request(userId: string, opts?: { reason?: string; source?: string }): Promise<IMResult<IMFriendRequest>> {
    return this._r('POST', '/api/im/contacts/request', { userId, ...opts });
  }

  /** List pending friend requests received */
  async pendingReceived(opts?: IMPaginationOptions): Promise<IMResult<IMFriendRequest[]>> {
    const params: Record<string, string> = {};
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.offset) params.offset = String(opts.offset);
    return this._r('GET', '/api/im/contacts/requests/received', undefined, params);
  }

  /** List pending friend requests sent */
  async pendingSent(opts?: IMPaginationOptions): Promise<IMResult<IMFriendRequest[]>> {
    const params: Record<string, string> = {};
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.offset) params.offset = String(opts.offset);
    return this._r('GET', '/api/im/contacts/requests/sent', undefined, params);
  }

  /** Accept a friend request */
  async accept(requestId: string): Promise<IMResult<{ contact: IMContact; conversationId: string }>> {
    return this._r('POST', `/api/im/contacts/requests/${requestId}/accept`);
  }

  /** Reject a friend request */
  async reject(requestId: string): Promise<IMResult<void>> {
    return this._r('POST', `/api/im/contacts/requests/${requestId}/reject`);
  }

  /** List friends */
  async friends(opts?: IMPaginationOptions): Promise<IMResult<IMContact[]>> {
    const params: Record<string, string> = {};
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.offset) params.offset = String(opts.offset);
    return this._r('GET', '/api/im/contacts/friends', undefined, params);
  }

  /** Remove a friend */
  async remove(userId: string): Promise<IMResult<void>> {
    return this._r('DELETE', `/api/im/contacts/${userId}/remove`);
  }

  /** Set a remark/alias for a contact */
  async setRemark(userId: string, remark: string): Promise<IMResult<void>> {
    return this._r('PATCH', `/api/im/contacts/${userId}/remark`, { remark });
  }

  /** Block a user */
  async block(userId: string): Promise<IMResult<void>> {
    return this._r('POST', `/api/im/contacts/${userId}/block`, {});
  }

  /** Unblock a user */
  async unblock(userId: string): Promise<IMResult<void>> {
    return this._r('DELETE', `/api/im/contacts/${userId}/block`);
  }

  /** List blocked users */
  async blocklist(opts?: IMPaginationOptions): Promise<IMResult<IMBlockedUser[]>> {
    const params: Record<string, string> = {};
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.offset) params.offset = String(opts.offset);
    return this._r('GET', '/api/im/contacts/blocked', undefined, params);
  }

  /** Get presence status for multiple users */
  async getPresence(userIds: string[]): Promise<IMResult<Array<{ userId: string; status: string; lastSeenAt?: string }>>> {
    return this._r('POST', '/api/im/presence/batch', { userIds });
  }
}

/** Social bindings (Telegram, Discord, Slack, etc.) */
export class BindingsClient {
  constructor(private _r: RequestFn) {}

  /** Create a social binding */
  async create(options: IMCreateBindingOptions): Promise<IMResult<IMBindingData>> {
    return this._r('POST', '/api/im/bindings', options);
  }

  /** Verify a binding with 6-digit code */
  async verify(bindingId: string, code: string): Promise<IMResult<void>> {
    return this._r('POST', `/api/im/bindings/${bindingId}/verify`, { code });
  }

  /** List bindings */
  async list(): Promise<IMResult<IMBinding[]>> {
    return this._r('GET', '/api/im/bindings');
  }

  /** Delete a binding */
  async delete(bindingId: string): Promise<IMResult<void>> {
    return this._r('DELETE', `/api/im/bindings/${bindingId}`);
  }
}

/** Credits balance and transaction history */
export class CreditsClient {
  constructor(private _r: RequestFn) {}

  /** Get credits balance */
  async get(): Promise<IMResult<IMCreditsData>> {
    return this._r('GET', '/api/im/credits');
  }

  /** Get credit transaction history */
  async transactions(options?: IMPaginationOptions): Promise<IMResult<IMTransaction[]>> {
    const query: Record<string, string> = {};
    if (options?.limit != null) query.limit = String(options.limit);
    if (options?.offset != null) query.offset = String(options.offset);
    return this._r('GET', '/api/im/credits/transactions', undefined, query);
  }
}

/** Workspace management (advanced collaborative environments) */
export class WorkspaceClient {
  constructor(private _r: RequestFn) {}

  /** Initialize a 1:1 workspace (1 user + 1 agent) */
  async init(options: IMWorkspaceInitOptions): Promise<IMResult<IMWorkspaceData>> {
    return this._r('POST', '/api/im/workspace/init', options);
  }

  /** Initialize a group workspace (multi-user + multi-agent) */
  async initGroup(options: IMWorkspaceInitGroupOptions): Promise<IMResult<IMWorkspaceData>> {
    return this._r('POST', '/api/im/workspace/init-group', options);
  }

  /** Create a low-level agent identity in a workspace. Role workflows use the role-builder harness. */
  async addAgent(
    workspaceId: string,
    options: IMWorkspaceCreateAgentOptions | string,
  ): Promise<IMResult<unknown>> {
    const body =
      typeof options === 'string'
        ? { agentName: options, agentDisplayName: options }
        : options;
    return this._r('POST', `/api/im/workspace/${workspaceId}/agents`, body);
  }

  /** List agents in a workspace */
  async listAgents(workspaceId: string): Promise<IMResult<any[]>> {
    return this._r('GET', `/api/im/workspace/${workspaceId}/agents`);
  }

  /** @mention autocomplete */
  async mentionAutocomplete(conversationId: string, query?: string): Promise<IMResult<IMAutocompleteResult[]>> {
    const q: Record<string, string> = { conversationId };
    if (query) q.q = query;
    return this._r('GET', '/api/im/workspace/mentions/autocomplete', undefined, q);
  }
}

/** Task management: create, list, claim, progress, complete, fail */
export class TasksClient {
  constructor(private _r: RequestFn) {}

  /** Create a new task */
  async create(options: IMCreateTaskOptions): Promise<IMResult<IMTask>> {
    return this._r('POST', '/api/im/tasks', options);
  }

  /** List tasks with optional filters */
  async list(options?: IMTaskListOptions): Promise<IMResult<IMTask[]>> {
    const query: Record<string, string> = {};
    query.view = options?.view ?? 'board';
    if (options?.kind) query.kind = options.kind;
    if (!options?.kind && query.view === 'board') query.kind = 'work_item,goal';
    if (options?.status) query.status = options.status;
    if (options?.capability) query.capability = options.capability;
    if (options?.assigneeId) query.assigneeId = options.assigneeId;
    if (options?.creatorId) query.creatorId = options.creatorId;
    if (options?.scheduleType) query.scheduleType = options.scheduleType;
    if (options?.limit != null) query.limit = String(options.limit);
    if (options?.cursor) query.cursor = options.cursor;
    if (options?.workspaceId) query.workspaceId = options.workspaceId;
    if (options?.projectId) query.projectId = options.projectId;
    if (options?.conversationId) query.conversationId = options.conversationId;
    return this._r('GET', '/api/im/tasks', undefined, query);
  }

  /** Get task details with logs */
  async get(taskId: string): Promise<IMResult<IMTaskDetail>> {
    return this._r('GET', `/api/im/tasks/${taskId}`);
  }

  /**
   * Wave-9 (v1.9.4) — fetch the canonical task result.
   *
   * Replaces the legacy "list IMAssets where kind=task-result + sourceTaskId"
   * pattern. Returns the locked shape defined by `IMTaskResult`; in
   * particular `assetIds` is always an array (possibly empty) so callers
   * can iterate without a null-check.
   *
   * Access: creator, assignee, or marketplace visibility on the task.
   */
  async getResult(taskId: string): Promise<IMResult<IMTaskResult>> {
    return this._r('GET', `/api/im/tasks/${taskId}/result`);
  }

  /**
   * Wave-9 (v1.9.4) — fetch the canonical run result.
   *
   * Same shape as `getResult` but reads from IMTaskRun.output instead of
   * IMTask.result. Use this for chat-mention dispatches whose result lives
   * on a run row rather than a board task. The `taskId` field of the
   * returned object is the run.id.
   */
  async getRunResult(runId: string): Promise<IMResult<IMTaskResult>> {
    return this._r('GET', `/api/im/runs/${runId}/result`);
  }

  /** Update a task */
  async update(taskId: string, options: IMUpdateTaskOptions): Promise<IMResult<IMTask>> {
    return this._r('PATCH', `/api/im/tasks/${taskId}`, options);
  }

  /** Move a task into a project, or pass null to return it to workspace-level. */
  async moveProject(taskId: string, targetProjectId: string | null): Promise<IMResult<IMTask>> {
    return this._r('POST', `/api/im/tasks/${taskId}/move-project`, { targetProjectId });
  }

  /** Claim a pending task */
  async claim(taskId: string): Promise<IMResult<IMTask>> {
    return this._r('POST', `/api/im/tasks/${taskId}/claim`);
  }

  /** Report progress on a task */
  async progress(taskId: string, options?: { message?: string; metadata?: Record<string, unknown> }): Promise<IMResult<void>> {
    return this._r('POST', `/api/im/tasks/${taskId}/progress`, options);
  }

  /** Complete a task with result */
  async complete(taskId: string, options?: IMCompleteTaskOptions): Promise<IMResult<IMTask>> {
    return this._r('POST', `/api/im/tasks/${taskId}/complete`, options);
  }

  /** Fail a task with error */
  async fail(taskId: string, error: string, metadata?: Record<string, unknown>): Promise<IMResult<IMTask>> {
    return this._r('POST', `/api/im/tasks/${taskId}/fail`, { error, metadata });
  }

  /** Approve a completed task */
  async approve(taskId: string): Promise<IMResult<IMTask>> {
    return this._r('POST', `/api/im/tasks/${taskId}/approve`);
  }

  /**
   * apc P-6 — post an auditable task event (`POST /tasks/:id/event`).
   *
   * Lands one `im_task_logs` row: `action = code.toLowerCase()`, `payload`
   * serialised into metadata. Server-side authorization: only the task
   * assignee may post. Used by `cloud skill ack` for skill invocation
   * receipts (code `SKILL_ACK` → action `skill_ack`).
   */
  async postEvent(
    taskId: string,
    options: { code: string; payload?: Record<string, unknown>; message?: string },
  ): Promise<IMResult<{ taskId: string; action: string }>> {
    return this._r('POST', `/api/im/tasks/${taskId}/event`, options);
  }

  /** Reject a task with reason */
  async reject(taskId: string, reason: string): Promise<IMResult<IMTask>> {
    return this._r('POST', `/api/im/tasks/${taskId}/reject`, { reason });
  }

  /** Cancel a task */
  async cancel(taskId: string): Promise<IMResult<IMTask>> {
    return this._r('DELETE', `/api/im/tasks/${taskId}`);
  }

  /**
   * v2.0 release 200 §6.1 — unified state-machine transition.
   *
   * Drives every kanban / approve / reject / cancel / blocked / retry /
   * restore action through one endpoint. The 5 legacy endpoints
   * (start/complete/approve/reject/cancel) remain for backward
   * compatibility but new integrations should prefer this entrypoint.
   *
   * Server responds 409 (`code: 'invalid-transition'`) if the requested
   * `to` is not in the TRANSITIONS matrix from the current status, or
   * 403 (`code: 'forbidden'`) if the actor's tier is not in the rule's
   * `allowedActors`.
   */
  async transition(
    taskId: string,
    options: {
      to:
        | 'pending'
        | 'assigned'
        | 'running'
        | 'review'
        | 'blocked'
        | 'awaiting_approval'
        | 'failed'
        | 'completed'
        | 'cancelled';
      assigneeId?: string | null;
      position?: number;
      reason?: string;
      reviewComment?: string;
    },
  ): Promise<IMResult<IMTask>> {
    return this._r('POST', `/api/im/tasks/${taskId}/transition`, options);
  }

  /**
   * v2.0 release 200 §5.3 — admin escape-hatch.
   *
   * Bypasses the TRANSITIONS matrix. Restricted to workspace owner /
   * admin / trustTier>=4. Reason is required; the call is audit-logged
   * with `force_transition: true`. UI does NOT expose this — ops only.
   */
  async forceTransition(
    taskId: string,
    options: {
      to:
        | 'pending'
        | 'assigned'
        | 'running'
        | 'review'
        | 'blocked'
        | 'awaiting_approval'
        | 'failed'
        | 'completed'
        | 'cancelled';
      reason: string;
    },
  ): Promise<IMResult<IMTask>> {
    return this._r('POST', `/api/im/tasks/${taskId}/force-transition`, options);
  }

  // ── release201/10 — acceptance criteria ──────────────────────────────

  /** Get rolled-up acceptance + criteria list for a task. */
  async getAcceptance(taskId: string): Promise<IMResult<unknown>> {
    return this._r('GET', `/api/im/tasks/${taskId}/acceptance`);
  }

  /** Copy a template's criteria onto the task. */
  async applyTemplate(taskId: string, templateId: string): Promise<IMResult<unknown>> {
    return this._r('POST', `/api/im/tasks/${taskId}/apply-template`, { templateId });
  }

  // ── release201/10 rev 2 — SPEC.md ─────────────────────────────────────

  readonly spec = {
    /** Read SPEC.md latest revision. */
    get: (taskId: string): Promise<IMResult<unknown>> =>
      this._r('GET', `/api/im/tasks/${taskId}/spec`),
    /** Owner sets/updates SPEC.md (writes a new revision). */
    set: (taskId: string, input: { markdown: string }): Promise<IMResult<unknown>> =>
      this._r('PUT', `/api/im/tasks/${taskId}/spec`, input),
  };

  // ── release201/10 rev 2 — TODO.md ─────────────────────────────────────

  readonly todo = {
    list: (taskId: string): Promise<IMResult<unknown>> =>
      this._r('GET', `/api/im/tasks/${taskId}/todo`),
    add: (
      taskId: string,
      input: { text: string; depth?: number },
    ): Promise<IMResult<unknown>> =>
      this._r('POST', `/api/im/tasks/${taskId}/todo/items`, input),
    toggle: (
      taskId: string,
      index: number,
      done?: boolean,
    ): Promise<IMResult<unknown>> =>
      this._r('PATCH', `/api/im/tasks/${taskId}/todo/items/${index}`, { done }),
    setText: (
      taskId: string,
      index: number,
      text: string,
    ): Promise<IMResult<unknown>> =>
      this._r('PATCH', `/api/im/tasks/${taskId}/todo/items/${index}`, { text }),
    remove: (taskId: string, index: number): Promise<IMResult<unknown>> =>
      this._r('DELETE', `/api/im/tasks/${taskId}/todo/items/${index}`),
  };

  readonly criteria = {
    /** List current criteria via the acceptance view. */
    list: (taskId: string): Promise<IMResult<unknown>> =>
      this._r('GET', `/api/im/tasks/${taskId}/acceptance`),
    /** Add a criterion (rev 2 — verifyMode + expectation + verifierAgentId). */
    add: (
      taskId: string,
      input: {
        verifyMode: 'qualitative' | 'quantitative' | 'agent-self-check' | 'manual';
        expectation: string;
        verifierAgentId?: string | null;
        required?: boolean;
        weight?: number;
        evidenceRefs?: unknown[];
        execution?: { command: string; cwd: string; workdirId: string };
        reviewKind?: 'code-review' | 'design-review';
      },
    ): Promise<IMResult<unknown>> => this._r('POST', `/api/im/tasks/${taskId}/criteria`, input),
    /** Update a criterion in place. */
    update: (
      taskId: string,
      cid: string,
      patch: {
        expectation?: string;
        verifyMode?: 'qualitative' | 'quantitative' | 'agent-self-check' | 'manual';
        verifierAgentId?: string | null;
        weight?: number;
        required?: boolean;
        evidenceRefs?: unknown[];
        execution?: { command: string; cwd: string; workdirId: string };
        reviewKind?: 'code-review' | 'design-review';
      },
    ): Promise<IMResult<unknown>> => this._r('PATCH', `/api/im/tasks/${taskId}/criteria/${cid}`, patch),
    /** Remove a criterion. */
    remove: (taskId: string, cid: string): Promise<IMResult<unknown>> =>
      this._r('DELETE', `/api/im/tasks/${taskId}/criteria/${cid}`),
    /**
     * Unified verify entry (rev 2). Manual reviewer, agent-self-check
     * report, AND verifier-agent report all use this — cloud routes by
     * actor identity.
     */
    verify: (
      taskId: string,
      cid: string,
      input: {
        outcome: 'passed' | 'failed' | 'n/a' | 'waived';
        note?: string;
        evidenceRefs?: string[];
        reviewArtifact?: unknown;
        waiveReason?: string;
      },
    ): Promise<IMResult<unknown>> =>
      this._r('POST', `/api/im/tasks/${taskId}/criteria/${cid}/verify`, input),
  };
}

/**
 * release201/10 — Criteria template store CRUD (workspace + global).
 */
export class CriteriaTemplatesClient {
  constructor(private _r: RequestFn) {}

  list(query?: { capability?: string; workspaceId?: string | null }): Promise<IMResult<unknown[]>> {
    const q: Record<string, string> = {};
    if (query?.capability) q.capability = query.capability;
    if (query?.workspaceId === null) q.workspaceId = '__global';
    else if (query?.workspaceId) q.workspaceId = query.workspaceId;
    return this._r('GET', '/api/im/criteria-templates', undefined, q);
  }

  get(id: string): Promise<IMResult<unknown>> {
    return this._r('GET', `/api/im/criteria-templates/${id}`);
  }

  create(input: {
    workspaceId?: string | null;
    capability: string;
    name: string;
    description?: string;
    criteria: unknown[];
    isDefault?: boolean;
  }): Promise<IMResult<unknown>> {
    return this._r('POST', '/api/im/criteria-templates', input);
  }

  update(id: string, patch: Record<string, unknown>): Promise<IMResult<unknown>> {
    return this._r('PATCH', `/api/im/criteria-templates/${id}`, patch);
  }

  delete(id: string): Promise<IMResult<unknown>> {
    return this._r('DELETE', `/api/im/criteria-templates/${id}`);
  }
}

/**
 * memory211/05 W3 — cross-workspace memory grant management plane
 * (`client.im.memory.grants.*`). Reachable as `client.im.memory.grants` —
 * same endpoints the `cloud memory-grant` CLI drives.
 *
 *   POST   /api/im/memory/grants           create / refresh (source owner human)
 *   GET    /api/im/memory/grants           granted list  (source owner human)
 *   GET    /api/im/memory/grants/incoming  incoming list (target owner human)
 *   DELETE /api/im/memory/grants/:id       revoke (source owner human, soft)
 *
 * Agent identities cannot manage grants — they file a `memory_grant` approval
 * instead (server answers 403 `MEMORY_GRANT_FORBIDDEN`).
 */
export class MemoryGrantsClient {
  constructor(private _r: RequestFn) {}

  /** Create or refresh a grant (an existing (source, target) row is revived with a new expiry). */
  async create(options: IMMemoryGrantCreateOptions): Promise<IMResult<IMMemoryGrant>> {
    const body: Record<string, unknown> = { targetWorkspaceId: options.targetWorkspaceId };
    if (options.expiresInDays !== undefined) body.expiresInDays = options.expiresInDays;
    const query: Record<string, string> = {};
    if (options.workspaceId) query.workspaceId = options.workspaceId;
    return this._r('POST', '/api/im/memory/grants', body, query);
  }

  /** Granted view (source perspective), newest first. */
  async list(options?: IMMemoryGrantListOptions): Promise<IMResult<IMMemoryGrant[]>> {
    const query: Record<string, string> = {};
    if (options?.workspaceId) query.workspaceId = options.workspaceId;
    return this._r('GET', '/api/im/memory/grants', undefined, query);
  }

  /** Incoming view (target perspective), newest first — includes revoked ledger rows. */
  async incoming(options?: IMMemoryGrantListOptions): Promise<IMResult<IMMemoryGrant[]>> {
    const query: Record<string, string> = {};
    if (options?.workspaceId) query.workspaceId = options.workspaceId;
    return this._r('GET', '/api/im/memory/grants/incoming', undefined, query);
  }

  /** Soft-revoke (idempotent; the row stays as a `revoked` ledger marker). */
  async revoke(grantId: string): Promise<IMResult<IMMemoryGrant>> {
    return this._r('DELETE', `/api/im/memory/grants/${encodeURIComponent(grantId)}`);
  }
}

/** Memory management: files, compaction, session load */
/** memory211/10 X2 — external import session faces (07 §3.2). */
export interface IMImportDocument {
  name: string;
  content: string;
  mime?: string;
}

export interface IMImportCandidate {
  pagePath: string;
  contentDiff: string;
  operation?: 'create' | 'replace_section';
  title?: string;
  rationale?: string;
  confidence?: number;
  triggerEvidence?: unknown;
}

export class MemoryImportClient {
  constructor(private _r: RequestFn) {}

  /** Open an import session (platform credential). */
  async open(options: { workspaceId: string }): Promise<IMResult<{ id: string }>> {
    return this._r('POST', '/api/im/memory/imports', { workspaceId: options.workspaceId });
  }

  /** L1 — land raw documents into the session (zero LLM, quota-guarded). */
  async writeDocuments(sessionId: string, options: { workspaceId: string; documents: IMImportDocument[] }): Promise<IMResult<{ accepted: number; documentCount: number }>> {
    return this._r('POST', `/api/im/memory/imports/${encodeURIComponent(sessionId)}/documents`, options);
  }

  /** L2 — submit distilled candidates (§2.1 metadata mandatory; lands as proposals). */
  async writeBatch(sessionId: string, options: { workspaceId: string; candidates: IMImportCandidate[] }): Promise<IMResult<{ proposalIds: string[] }>> {
    return this._r('POST', `/api/im/memory/imports/${encodeURIComponent(sessionId)}/candidates`, options);
  }

  /** L3 — run the §2.5 gate over the session batch. */
  async commit(sessionId: string, options: { workspaceId: string }): Promise<IMResult<unknown>> {
    return this._r('POST', `/api/im/memory/imports/${encodeURIComponent(sessionId)}/commit`, options);
  }

  /** Session status + per-candidate states. */
  async status(sessionId: string, options: { workspaceId: string }): Promise<IMResult<unknown>> {
    const query: Record<string, string> = { workspaceId: options.workspaceId };
    return this._r('GET', `/api/im/memory/imports/${encodeURIComponent(sessionId)}`, undefined, query);
  }
}

export class MemoryClient {
  /** Cross-workspace grant management plane (memory211/05 W3). */
  readonly grants: MemoryGrantsClient;

  /** memory211/10 X2 — external import pipeline (07 §3.1 L1→L3). */
  readonly imports: MemoryImportClient;

  constructor(private _r: RequestFn) {
    this.grants = new MemoryGrantsClient(_r);
    this.imports = new MemoryImportClient(_r);
  }

  /** Create a memory file */
  async createFile(options: IMCreateMemoryFileOptions): Promise<IMResult<IMMemoryFile>> {
    return this._r('POST', '/api/im/memory/files', options);
  }

  /** List memory files */
  async listFiles(options?: { scope?: string; path?: string }): Promise<IMResult<IMMemoryFile[]>> {
    const query: Record<string, string> = {};
    if (options?.scope) query.scope = options.scope;
    if (options?.path) query.path = options.path;
    return this._r('GET', '/api/im/memory/files', undefined, query);
  }

  /** Get a memory file by ID */
  async getFile(fileId: string): Promise<IMResult<IMMemoryFileDetail>> {
    return this._r('GET', `/api/im/memory/files/${fileId}`);
  }

  /** Update a memory file (append, replace, or replace_section) */
  async updateFile(fileId: string, options: IMUpdateMemoryFileOptions): Promise<IMResult<IMMemoryFileDetail>> {
    return this._r('PATCH', `/api/im/memory/files/${fileId}`, options);
  }

  /** Delete a memory file */
  async deleteFile(fileId: string): Promise<IMResult<void>> {
    return this._r('DELETE', `/api/im/memory/files/${fileId}`);
  }

  /** Compact conversation messages into a summary */
  async compact(options: IMCompactOptions): Promise<IMResult<IMCompactionSummary>> {
    return this._r('POST', '/api/im/memory/compact', options);
  }

  /** Get compaction summaries for a conversation */
  async getCompaction(conversationId: string): Promise<IMResult<IMCompactionSummary[]>> {
    return this._r('GET', `/api/im/memory/compact/${conversationId}`);
  }

  /** Load memory for session context */
  async load(scope?: string): Promise<IMResult<IMMemoryLoadResult>> {
    const query: Record<string, string> = {};
    if (scope) query.scope = scope;
    return this._r('GET', '/api/im/memory/load', undefined, query);
  }

  /** Get memory-gene knowledge links for the authenticated user's memory files (v1.8.0) */
  async getKnowledgeLinks(): Promise<IMResult<IMMemoryKnowledgeLinks>> {
    return this._r('GET', '/api/im/memory/links');
  }

  /**
   * Get a CC-style always-load digest of all memory files (v1.9.3).
   * The digest is a Markdown bundle suitable for prepending to LLM context.
   * Server clamps `maxLines` to 10–1000 and `maxBytes` to 500–30000.
   */
  async digest(options?: IMMemoryDigestOptions): Promise<IMResult<IMMemoryDigest>> {
    const query: Record<string, string> = {};
    if (options?.scope) query.scope = options.scope;
    if (options?.maxLines != null) query.maxLines = String(options.maxLines);
    if (options?.maxBytes != null) query.maxBytes = String(options.maxBytes);
    return this._r('GET', '/api/im/memory/digest', undefined, query);
  }

  /**
   * Cross-workspace batch search through an active grant (memory211/05 W3).
   *
   * The response is a PURE external result set — it never mixes the caller's
   * own workspace pages in. Hits carry `tier:'grant'` + `via:'grant:<id>'` +
   * `sourceWorkspaceId`; `lane` keeps the evidence leg of the existing
   * pipeline. A text miss carries band-filtered `navigation` start points.
   *
   * Errors arrive as fail envelopes (never thrown): 404
   * `MEMORY_EXTERNAL_UNAVAILABLE` covers every unreachable reason (no grant /
   * revoked / expired / ownership change / source gone / path out of band)
   * with no reason leak; 403 `MEMORY_GRANT_FORBIDDEN` = agent or non-owner
   * caller; 429 `MEMORY_EXTERNAL_RATE_LIMITED` = per-(caller, source) budget
   * exhausted (`error.details.limit` / `error.details.retryAfterMs`); 409
   * `MEMORY_ACCESS_VERSION_CHANGED` = reconcile and retry.
   */
  async externalSearch(options: IMMemoryExternalSearchOptions): Promise<IMResult<IMMemoryExternalSearchResult>> {
    const body: Record<string, unknown> = {
      sourceWorkspaceId: options.sourceWorkspaceId,
      queries: options.queries,
    };
    if (options.limit !== undefined) body.limit = options.limit;
    const query: Record<string, string> = {};
    if (options.workspaceId) query.workspaceId = options.workspaceId;
    return this._r('POST', '/api/im/memory/external/search', body, query);
  }

  /** Cross-workspace single-page load through an active grant (same error semantics as `externalSearch`). */
  async externalLoad(options: IMMemoryExternalLoadOptions): Promise<IMResult<IMMemoryExternalLoadResult>> {
    const body: Record<string, unknown> = {
      sourceWorkspaceId: options.sourceWorkspaceId,
      path: options.path,
    };
    if (options.format !== undefined) body.format = options.format;
    const query: Record<string, string> = {};
    if (options.workspaceId) query.workspaceId = options.workspaceId;
    return this._r('POST', '/api/im/memory/external/load', body, query);
  }
}

/** Knowledge Links: bidirectional associations between Memory, Gene, Capsule, Signal entities (v1.8.0) */
export class KnowledgeLinkClient {
  constructor(private _r: RequestFn) {}

  /**
   * Get all knowledge links for a given entity.
   * @param entityType - One of: memory, gene, capsule, signal
   * @param entityId   - The entity ID
   */
  async getLinks(entityType: KnowledgeLinkSource, entityId: string): Promise<IMResult<IMKnowledgeLink[]>> {
    return this._r('GET', '/api/im/knowledge/links', undefined, { entityType, entityId });
  }
}

// ============================================================================
// Metrics (v2.0.7 release201/11)
// ============================================================================

export type MetricAgg = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'p50' | 'p95' | 'p99';
export type MetricBucket = '5m' | '1h' | '1d';

export interface MetricEmitInput {
  namespace: string;
  name: string;
  ts?: string;
  value?: number | string | null;
  /** workspaceId is required by the server; other dims are free-form. */
  dims: Record<string, string | number | boolean | null | undefined> & { workspaceId: string };
}

export interface MetricAggregateOptions {
  namespace: string;
  name: string;
  agg: MetricAgg;
  /** workspaceId is required; service rejects queries without it. */
  filter: Record<string, string> & { workspaceId: string };
  range?: string; // e.g. '24h' | '7d' | '30d'
  from?: string;
  to?: string;
  groupBy?: string[];
  bucket?: MetricBucket;
}

export interface MetricBucketResult {
  ts: string | null;
  groups: Array<{ groupKey: Record<string, string | null>; value: number | null }>;
}

export interface MetricAggregateResponse {
  namespace: string;
  name: string;
  agg: MetricAgg;
  range: { from: string; to: string };
  buckets: MetricBucketResult[];
}

/**
 * B-P1c — scope axis of `turnSummary()` (GET /api/im/metrics/turns).
 */
export type TurnScope = 'conversation' | 'task' | 'agent';

/**
 * Frozen contract — mirrors `TurnMetricsSummary` in
 * src/im/services/metric-turns.service.ts VERBATIM (field names are additive
 * only; renames / removals are not allowed). `null` always means "no rows in
 * the window" — never 0-by-inference, never NaN. `turnCountByStatus` carries
 * `null` for a status the window never saw (the daemon emits only ok/error);
 * `models` lists only turns that carried a model dim, so sum(models.turns)
 * can be < turnCount.
 */
export interface TurnMetricsSummary {
  turnCount: number;
  turnCountByStatus: { ok: number | null; error: number | null };
  avgTokensPerTurn: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
  };
  cacheHitRatio: number | null;
  p95FirstEventMs: number | null;
  avgDurationMs: number | null;
  toolCallsPerTurn: number | null;
  models: Array<{ model: string; turns: number }>;
}

export interface TurnSummaryOptions {
  scope: TurnScope;
  /** conversationId | taskId | agentId (IM user id of the agent). */
  id: string;
  /** Mandatory; a plain query param on /turns (unlike aggregate()'s filter csv). */
  workspaceId: string;
  /** e.g. '24h' | '7d' — same Nh|Nd grammar as aggregate(); default 24h. */
  range?: string;
  from?: string;
  to?: string;
}

export interface MetricEventsOptions {
  namespace: string;
  name: string;
  /** workspaceId is required; other keys ride the filter csv like aggregate(). */
  filter: Record<string, string> & { workspaceId: string };
  range?: string;
  from?: string;
  to?: string;
  /** Server default 50, clamped to 200. */
  limit?: number;
}

/** One raw event row (runtime210/06 W12b provenance read). */
export interface MetricEventRow {
  id: string;
  ts: string;
  valueNumeric: number | null;
  valueString: string | null;
  dims: Record<string, unknown> | null;
  source: string;
  sourceId: string | null;
}

export interface MetricEventsResponse {
  namespace: string;
  name: string;
  range: { from: string; to: string };
  events: MetricEventRow[];
}

/**
 * release201/11 §6 — unified metric data channel.
 *
 * - `emit()` queues a single event on the cloud-side MetricService.
 * - `batch()` ships an array of events (≤ 500) — used by daemon outbox flush
 *   in Phase 2.
 * - `aggregate()` runs a server-side query against `im_metric_events`.
 * - `events()` reads the raw rows behind an aggregate (provenance drill-down).
 * - `turnSummary()` joins the turn.* family into a scoped summary (B-P1d).
 */
export class MetricsClient {
  constructor(private _r: RequestFn) {}

  async emit(input: MetricEmitInput): Promise<IMResult<{ queued: boolean }>> {
    return this._r('POST', '/api/im/metrics/emit', input);
  }

  async batch(events: MetricEmitInput[]): Promise<IMResult<{ accepted: number; rejected: number; errors: Array<{ index: number; error: string }> }>> {
    return this._r('POST', '/api/im/metrics/batch', { events });
  }

  async aggregate(opts: MetricAggregateOptions): Promise<IMResult<MetricAggregateResponse>> {
    const query: Record<string, string> = {
      namespace: opts.namespace,
      name: opts.name,
      agg: opts.agg,
    };
    if (opts.range) query.range = opts.range;
    if (opts.from) query.from = opts.from;
    if (opts.to) query.to = opts.to;
    if (opts.groupBy && opts.groupBy.length) query.groupBy = opts.groupBy.join(',');
    if (opts.bucket) query.bucket = opts.bucket;
    const filterPairs = Object.entries(opts.filter).map(([k, v]) => `${k}:${v}`);
    if (filterPairs.length) query.filter = filterPairs.join(',');
    return this._r('GET', '/api/im/metrics/aggregate', undefined, query);
  }

  /**
   * B-P1d — raw event rows behind an aggregate (runtime210/06 W12b
   * provenance read). workspaceId is mandatory on the filter — same
   * cross-workspace rule as aggregate(); the server rejects without it.
   */
  async events(opts: MetricEventsOptions): Promise<IMResult<MetricEventsResponse>> {
    const query: Record<string, string> = {
      namespace: opts.namespace,
      name: opts.name,
    };
    if (opts.range) query.range = opts.range;
    if (opts.from) query.from = opts.from;
    if (opts.to) query.to = opts.to;
    if (opts.limit !== undefined) query.limit = String(opts.limit);
    const filterPairs = Object.entries(opts.filter).map(([k, v]) => `${k}:${v}`);
    if (filterPairs.length) query.filter = filterPairs.join(',');
    return this._r('GET', '/api/im/metrics/events', undefined, query);
  }

  /**
   * B-P1d — conversation / task / agent scoped turn summary over the turn.*
   * family. The response `data` shape is the frozen TurnMetricsSummary
   * contract above.
   */
  async turnSummary(opts: TurnSummaryOptions): Promise<IMResult<TurnMetricsSummary>> {
    const query: Record<string, string> = {
      scope: opts.scope,
      id: opts.id,
      workspaceId: opts.workspaceId,
    };
    if (opts.range) query.range = opts.range;
    if (opts.from) query.from = opts.from;
    if (opts.to) query.to = opts.to;
    return this._r('GET', '/api/im/metrics/turns', undefined, query);
  }
}

/** Identity key management: Ed25519 keys, attestation, audit */
export class IdentityClient {
  constructor(private _r: RequestFn) {}

  /** Get server public key */
  async getServerKey(): Promise<IMResult<{ publicKey: string }>> {
    return this._r('GET', '/api/im/keys/server');
  }

  /** Register or rotate an identity key */
  async registerKey(options: IMRegisterKeyOptions): Promise<IMResult<IMIdentityKey>> {
    return this._r('PUT', '/api/im/keys/identity', options);
  }

  /** Get a user's identity key */
  async getKey(userId: string): Promise<IMResult<IMIdentityKey>> {
    return this._r('GET', `/api/im/keys/identity/${userId}`);
  }

  /** Revoke own identity key */
  async revokeKey(): Promise<IMResult<void>> {
    return this._r('POST', '/api/im/keys/identity/revoke');
  }

  /** Get key audit log for a user */
  async getAuditLog(userId: string): Promise<IMResult<IMKeyAuditEntry[]>> {
    return this._r('GET', `/api/im/keys/audit/${userId}`);
  }

  /** Verify key audit log integrity */
  async verifyAuditLog(userId: string): Promise<IMResult<IMKeyVerifyResult>> {
    return this._r('GET', `/api/im/keys/audit/${userId}/verify`);
  }
}

/** Conversation security: E2E encryption settings and key management */
export class SecurityClient {
  constructor(private _r: RequestFn) {}

  /** Get conversation security settings */
  async getConversationSecurity(conversationId: string): Promise<IMResult<any>> {
    return this._r('GET', `/api/im/conversations/${conversationId}/security`);
  }

  /** Update conversation security settings */
  async setConversationSecurity(conversationId: string, options: { signingPolicy?: string; encryptionMode?: string }): Promise<IMResult<any>> {
    return this._r('PATCH', `/api/im/conversations/${conversationId}/security`, options);
  }

  /** Upload a public key for a conversation */
  async uploadKey(conversationId: string, publicKey: string, algorithm?: string): Promise<IMResult<any>> {
    const body: Record<string, any> = { publicKey };
    if (algorithm) body.algorithm = algorithm;
    return this._r('POST', `/api/im/conversations/${conversationId}/keys`, body);
  }

  /** Get keys for a conversation */
  async getKeys(conversationId: string): Promise<IMResult<any[]>> {
    return this._r('GET', `/api/im/conversations/${conversationId}/keys`);
  }

  /** Revoke a key for a specific user in a conversation */
  async revokeKey(conversationId: string, keyUserId: string): Promise<IMResult<any>> {
    return this._r('DELETE', `/api/im/conversations/${conversationId}/keys/${keyUserId}`);
  }
}

/** Skill catalog and agent installation lifecycle. Kept under Evolution for v2.0 compatibility. */
export class EvolutionSkillsClient {
  constructor(private _r: RequestFn) {}

  /** List the skill catalog. Alias of search() for the v2.0 public surface. */
  async list(options?: IMSkillSearchOptions): Promise<IMResult<IMSkillInfo[]>> {
    return this.search(options);
  }

  /** Browse and search the skill catalog. */
  async search(options?: IMSkillSearchOptions): Promise<IMResult<IMSkillInfo[]>> {
    const query: Record<string, string> = {};
    if (options?.query) query.query = options.query;
    if (options?.category) query.category = options.category;
    if (options?.source) query.source = options.source;
    if (options?.compatibility) query.compatibility = options.compatibility;
    if (options?.sort) query.sort = options.sort;
    if (options?.page != null) query.page = String(options.page);
    if (options?.limit != null) query.limit = String(options.limit);
    return this._r('GET', '/api/im/skills/search', undefined, query);
  }

  /** Get skill catalog stats. */
  async stats(): Promise<IMResult<any>> {
    return this._r('GET', '/api/im/skills/stats');
  }

  /** List available skill categories. */
  async categories(): Promise<IMResult<Array<{ category: string; count: number }>>> {
    return this._r('GET', '/api/im/skills/categories');
  }

  /** List trending skills. */
  async trending(limit?: number): Promise<IMResult<IMSkillInfo[]>> {
    const query: Record<string, string> = {};
    if (limit != null) query.limit = String(limit);
    return this._r('GET', '/api/im/skills/trending', undefined, query);
  }

  /** List skills created by the authenticated agent. */
  async created(): Promise<IMResult<IMSkillInfo[]>> {
    return this._r('GET', '/api/im/skills/created');
  }

  /** Get skill detail by slug or ID. */
  async get(slugOrId: string): Promise<IMResult<IMSkillInfo & { content?: string; metadata?: Record<string, unknown> }>> {
    return this._r('GET', `/api/im/skills/${encodeURIComponent(slugOrId)}`);
  }

  /** Get full SKILL.md content and package metadata. */
  async content(slugOrId: string): Promise<IMResult<IMSkillContent>> {
    return this._r('GET', `/api/im/skills/${encodeURIComponent(slugOrId)}/content`);
  }

  /** Create/submit a workspace or community skill. */
  async create(input: IMSkillCreateInput): Promise<IMResult<IMSkillInfo & { content?: string }>> {
    return this._r('POST', '/api/im/skills', input);
  }

  /** Update a skill. */
  async update(skillId: string, input: IMSkillUpdateInput): Promise<IMResult<IMSkillInfo & { content?: string }>> {
    return this._r('PATCH', `/api/im/skills/${encodeURIComponent(skillId)}`, input);
  }

  /** Soft-delete/deprecate a skill. */
  async delete(skillId: string): Promise<IMResult<void>> {
    return this._r('DELETE', `/api/im/skills/${encodeURIComponent(skillId)}`);
  }

  /** Install a skill for the authenticated agent. */
  async install(slugOrId: string, scope?: string): Promise<IMResult<IMSkillInstallResult>> {
    return this._r('POST', `/api/im/skills/${encodeURIComponent(slugOrId)}/install`, scope ? { scope } : undefined);
  }

  /** Uninstall a skill for the authenticated agent. */
  async uninstall(slugOrId: string, scope?: string): Promise<IMResult<{ uninstalled: boolean }>> {
    const query = scope ? { scope } : undefined;
    return this._r('DELETE', `/api/im/skills/${encodeURIComponent(slugOrId)}/install`, undefined, query);
  }

  /**
   * List installed skills. When agentId is supplied, this uses the v2.0 Layer 5
   * route and includes daemon sync state; otherwise it keeps the legacy current-agent route.
   */
  async installed(options?: IMAgentSkillListOptions): Promise<IMResult<IMAgentSkillRecord[]>> {
    const query: Record<string, string> = {};
    if (options?.workspaceId) query.workspaceId = options.workspaceId;
    if (options?.includeInactive) query.includeInactive = 'true';
    if (options?.agentId) {
      return this._r('GET', `/api/im/agents/${encodeURIComponent(options.agentId)}/skills`, undefined, query);
    }
    return this._r('GET', '/api/im/skills/installed', undefined, query);
  }

  /** Install a skill to a specific agent. */
  async installForAgent(
    agentId: string,
    skillIdOrSlug: string,
    options?: IMAgentSkillInstallOptions,
  ): Promise<IMResult<IMSkillInstallResult>> {
    return this._r('POST', `/api/im/agents/${encodeURIComponent(agentId)}/skills`, {
      skillId: skillIdOrSlug,
      ...options,
    });
  }

  /** Disable/uninstall a skill from a specific agent. Built-ins are disabled cloud-side. */
  async uninstallFromAgent(
    agentId: string,
    skillIdOrSlug: string,
    options?: { workspaceId?: string },
  ): Promise<IMResult<{ changed: boolean; status: string; builtIn?: boolean }>> {
    return this._r('DELETE', `/api/im/agents/${encodeURIComponent(agentId)}/skills`, {
      skillId: skillIdOrSlug,
      workspaceId: options?.workspaceId,
    });
  }

  /** List skills whose daemon sync state is not current. */
  async pending(agentId: string, workspaceId?: string): Promise<IMResult<IMAgentSkillRecord[]>> {
    const query = workspaceId ? { workspaceId } : undefined;
    return this._r('GET', `/api/im/agents/${encodeURIComponent(agentId)}/skills/pending`, undefined, query);
  }

  /** Acknowledge daemon sync for an installed skill. */
  async ack(agentId: string, input: IMAgentSkillAckInput): Promise<IMResult<IMAgentSkillRecord>> {
    return this._r('POST', `/api/im/agents/${encodeURIComponent(agentId)}/skills/ack`, input);
  }

  /** Star a skill. */
  async star(skillId: string): Promise<IMResult<{ stars?: number }>> {
    return this._r('POST', `/api/im/skills/${encodeURIComponent(skillId)}/star`);
  }
}

/** Agent 4-tuple lifecycle: spec, snapshots, publish, and fork. */
/**
 * release201/13 §3.4 + §11 13-P2 — Per-agent skill management sub-client.
 * Surfaces install / uninstall / list / config-update against
 * `/api/im/agents/:agentId/skills/...`.
 */
export class AgentSkillsClient {
  constructor(private _r: RequestFn) {}

  /** List skills installed on the agent. */
  async list(
    agentId: string,
    options?: { workspaceId?: string; includeInactive?: boolean },
  ): Promise<IMResult<unknown[]>> {
    const query: Record<string, string> = {};
    if (options?.workspaceId) query.workspaceId = options.workspaceId;
    if (options?.includeInactive) query.includeInactive = 'true';
    return this._r('GET', `/api/im/agents/${encodeURIComponent(agentId)}/skills`, undefined, query);
  }

  /** Install a published skill onto the agent. */
  async install(
    agentId: string,
    input: { skillId?: string; slug?: string; workspaceId?: string; config?: Record<string, unknown>; version?: string },
  ): Promise<IMResult<unknown>> {
    return this._r('POST', `/api/im/agents/${encodeURIComponent(agentId)}/skills`, input);
  }

  /** Uninstall (or disable, for built-ins) a skill from the agent. */
  async uninstall(
    agentId: string,
    skillIdOrSlug: string,
    options?: { workspaceId?: string },
  ): Promise<IMResult<unknown>> {
    const query: Record<string, string> = {};
    if (options?.workspaceId) query.workspaceId = options.workspaceId;
    return this._r(
      'DELETE',
      `/api/im/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillIdOrSlug)}`,
      undefined,
      query,
    );
  }

  /**
   * PATCH /api/im/agents/:agentId/skills/:skillId — Update per-skill config.
   *
   * Validates against the skill's `executableJson.configSchema` server-side
   * (release201/13 §3.4 / 07 §2.6). Returns the updated agentSkill row;
   * `installedRevision` will be null until the next daemon sync poll.
   */
  async updateConfig(
    agentId: string,
    skillId: string,
    config: Record<string, unknown>,
    options?: { workspaceId?: string },
  ): Promise<IMResult<unknown>> {
    return this._r(
      'PATCH',
      `/api/im/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
      { config, workspaceId: options?.workspaceId },
    );
  }
}

export class AgentsClient {
  readonly skills: AgentSkillsClient;

  constructor(private _r: RequestFn) {
    this.skills = new AgentSkillsClient(_r);
  }

  /** Discover AgentCard-backed agents in a workspace the caller belongs to. */
  async discover(options: IMAgentDiscoverOptions): Promise<IMResult<IMAgentCatalogEntry[]>> {
    const query: Record<string, string> = { workspaceId: options.workspaceId };
    if (options.agentType) query.agentType = options.agentType;
    if (options.capability) query.capability = options.capability;
    if (options.onlineOnly) query.onlineOnly = 'true';
    return this._r('GET', '/api/im/agents', undefined, query);
  }

  async spec(agentId: string, workspaceId?: string): Promise<IMResult<IMAgentSpec>> {
    const query = workspaceId ? { workspaceId } : undefined;
    return this._r('GET', `/api/im/agents/${encodeURIComponent(agentId)}/spec`, undefined, query);
  }

  async snapshot(agentId: string, options?: IMAgentSnapshotOptions): Promise<IMResult<IMAgentSnapshot>> {
    return this._r('POST', `/api/im/agents/${encodeURIComponent(agentId)}/snapshot`, options ?? {});
  }

  async snapshots(
    agentId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<IMResult<{ items: IMAgentSnapshot[]; nextCursor?: string }>> {
    const query: Record<string, string> = {};
    if (options?.cursor) query.cursor = options.cursor;
    if (options?.limit != null) query.limit = String(options.limit);
    return this._r('GET', `/api/im/agents/${encodeURIComponent(agentId)}/snapshots`, undefined, query);
  }

  async restore(
    agentId: string,
    options: IMAgentRestoreOptions,
  ): Promise<IMResult<{ restored: boolean; agentSpec: IMAgentSpec; snapshot: IMAgentSnapshot }>> {
    return this._r('POST', `/api/im/agents/${encodeURIComponent(agentId)}/restore`, options);
  }

  async publish(agentId: string, options?: IMAgentPublishOptions): Promise<IMResult<IMAgentPack>> {
    return this._r('POST', `/api/im/agents/${encodeURIComponent(agentId)}/publish`, options ?? {});
  }

  async listPacks(options?: IMAgentPackListOptions): Promise<IMResult<{ items: IMAgentPack[]; nextCursor?: string }>> {
    const query: Record<string, string> = {};
    if (options?.q) query.q = options.q;
    if (options?.curatedQuality) query.curatedQuality = options.curatedQuality;
    if (options?.license) query.license = options.license;
    if (options?.publisherDid) query.publisherDid = options.publisherDid;
    if (options?.cursor) query.cursor = options.cursor;
    if (options?.limit != null) query.limit = String(options.limit);
    return this._r('GET', '/api/im/agent-packs', undefined, query);
  }

  async forkPack(packIdOrSlug: string, options: IMAgentForkOptions): Promise<IMResult<IMAgentForkResult>> {
    return this._r('POST', `/api/im/agent-packs/${encodeURIComponent(packIdOrSlug)}/fork`, options);
  }

  async deletePack(packIdOrSlug: string): Promise<IMResult<{ deleted: boolean; packageId: string }>> {
    return this._r('DELETE', `/api/im/agent-packs/${encodeURIComponent(packIdOrSlug)}`);
  }

  // release201/09 §9.7.2 Phase 3 — agent quiesce + transfer endpoints.
  //
  // pause/resume: workspace owner / orchestrator / admin only. Used by
  // `prismer agent export` to halt cloud dispatch on the source device
  // before tarballing the agent dir, and by `prismer agent import` to
  // resume dispatch on the target device after rebind.

  async pause(agentId: string): Promise<IMResult<{ agentImUserId: string; pausedAt: string; alreadyPaused: boolean }>> {
    return this._r('POST', `/api/im/agents/${encodeURIComponent(agentId)}/pause`, {});
  }

  async resume(agentId: string): Promise<IMResult<{ agentImUserId: string; resumed: boolean }>> {
    return this._r('POST', `/api/im/agents/${encodeURIComponent(agentId)}/resume`, {});
  }

  async transfer(input: {
    agentId: string;
    fromDaemonId: string;
    toDaemonId: string;
    manifestSha256: string;
  }): Promise<
    IMResult<{
      agentImUserId: string;
      previousDaemonId: string;
      boundDaemonId: string;
      boundDaemonKind: string;
      boundDaemonLabel: string;
      boundBy: string;
      boundAt: string;
      manifestSha256: string;
    }>
  > {
    return this._r('POST', '/api/im/agent-bindings/transfer', input);
  }
}

// ── Studio (release201/13 §3.9) ─────────────────────────────────────────────
// Skill Studio BFF endpoints — overview / profile / installed in 13-P1;
// authoring / lifecycle / evolution / metrics arrive in 13-P2 / 13-P3.

export interface IMStudioOverview {
  workspaceId: string | null;
  counts: {
    drafts: number;
    inEval: number;
    pendingReview: number;
    publishedThisWeek: number;
  };
  recentLifecycle: Array<{
    skillId: string;
    slug: string;
    name: string;
    status: string;
    updatedAt: string;
  }>;
  recentActivity: Array<{
    type: string;
    skillSlug?: string;
    timestamp: string;
    summary: string;
  }>;
}

export interface IMStudioAgentSummary {
  agentId: string;
  username: string;
  displayName: string;
  agentType: string;
  status: string;
  workspaceId: string | null;
  capabilities: string[];
}

export interface IMStudioInstalledSkill {
  skillId: string;
  slug: string;
  name: string;
  version: string | null;
  status: string;
  installedAt: string;
  lastInvokedAt: string | null;
  fromGene: boolean;
}

export interface IMStudioInstalled {
  workspaceId: string | null;
  agents: IMStudioAgentSummary[];
  activeAgentId: string | null;
  skills: IMStudioInstalledSkill[];
}

export interface IMStudioProfile {
  agentId: string | null;
  identity: {
    agentName: string;
    displayName: string;
    agentType: string;
    did: string | null;
    capabilities: string[];
    status: string;
  } | null;
  personality: {
    rigor: number;
    creativity: number;
    risk_tolerance: number;
    soul: string | null;
  } | null;
  credits: {
    balance: number;
    totalSpent: number;
    totalEarned: number;
  } | null;
  workspaces: Array<{ workspaceId: string; name: string }>;
}

/**
 * Studio Evolution sub-client (release201/13 §3.6 + §11 13-P3).
 *
 * Workspace-owner-scoped capsule + gene listing for any agent the caller can
 * inspect (own agent, workspace owner / admin / member). Does NOT reuse
 * `/api/im/evolution/capsules` (which is auth-user-scoped). See §0.2.4
 * forbidden-pattern: "user-scoped endpoint accessed by workspace-owner".
 */
export class StudioEvolutionClient {
  constructor(private _r: RequestFn) {}

  /** List capsules emitted by the target agent (workspace-owner-scoped). */
  async capsules(
    agentId: string,
    options?: { page?: number; limit?: number; scope?: string },
  ): Promise<IMResult<{ capsules: unknown[]; total: number; page: number; limit: number; agentId: string }>> {
    const query: Record<string, string> = { agentId };
    if (options?.page != null) query.page = String(options.page);
    if (options?.limit != null) query.limit = String(options.limit);
    if (options?.scope) query.scope = options.scope;
    return this._r('GET', '/api/im/studio/evolution/capsules', undefined, query);
  }

  /** List genes owned by the target agent (workspace-owner-scoped). */
  async genes(
    agentId: string,
    options?: { signals?: string },
  ): Promise<IMResult<{ genes: unknown[]; agentId: string }>> {
    const query: Record<string, string> = { agentId };
    if (options?.signals) query.signals = options.signals;
    return this._r('GET', '/api/im/studio/evolution/genes', undefined, query);
  }
}

export class StudioClient {
  readonly evolution: StudioEvolutionClient;

  constructor(private _r: RequestFn) {
    this.evolution = new StudioEvolutionClient(_r);
  }

  /** Studio overview — counts + recent activity for a workspace. */
  async getOverview(workspaceId?: string): Promise<IMResult<IMStudioOverview>> {
    const query = workspaceId ? { workspaceId } : undefined;
    return this._r('GET', '/api/im/studio/overview', undefined, query);
  }

  /** Studio Profile domain — agent identity / personality / credits. */
  async getProfile(agentId?: string): Promise<IMResult<IMStudioProfile>> {
    const query = agentId ? { agentId } : undefined;
    return this._r('GET', '/api/im/studio/profile', undefined, query);
  }

  /** Studio Installed domain — workspace agents + active agent's skills. */
  async getInstalled(options?: { workspaceId?: string; agentId?: string }): Promise<IMResult<IMStudioInstalled>> {
    const query: Record<string, string> = {};
    if (options?.workspaceId) query.workspaceId = options.workspaceId;
    if (options?.agentId) query.agentId = options.agentId;
    return this._r('GET', '/api/im/studio/installed', undefined, query);
  }
}

/** Skill Evolution: gene management, analysis, recording, distillation */
export class EvolutionClient {
  readonly skills: EvolutionSkillsClient;

  constructor(private _r: RequestFn) {
    this.skills = new EvolutionSkillsClient(_r);
  }

  // ── Public endpoints (no auth required) ──

  /** Get evolution stats */
  async getStats(): Promise<IMResult<IMEvolutionStats>> {
    return this._r('GET', '/api/im/evolution/public/stats');
  }

  /** Get hot/trending genes */
  async getHotGenes(limit?: number): Promise<IMResult<IMGene[]>> {
    const query: Record<string, string> = {};
    if (limit != null) query.limit = String(limit);
    return this._r('GET', '/api/im/evolution/public/hot', undefined, query);
  }

  /** Browse published genes */
  async browseGenes(options?: IMGeneListOptions): Promise<IMResult<IMGene[]>> {
    const query: Record<string, string> = {};
    if (options?.category) query.category = options.category;
    if (options?.search) query.search = options.search;
    if (options?.sort) query.sort = options.sort;
    if (options?.page != null) query.page = String(options.page);
    if (options?.limit != null) query.limit = String(options.limit);
    return this._r('GET', '/api/im/evolution/public/genes', undefined, query);
  }

  /** Get a public gene by ID */
  async getPublicGene(geneId: string): Promise<IMResult<IMGene>> {
    return this._r('GET', `/api/im/evolution/public/genes/${geneId}`);
  }

  /** Get capsules for a public gene */
  async getGeneCapsules(geneId: string, limit?: number): Promise<IMResult<IMCapsule[]>> {
    const query: Record<string, string> = {};
    if (limit != null) query.limit = String(limit);
    return this._r('GET', `/api/im/evolution/public/genes/${geneId}/capsules`, undefined, query);
  }

  /** Get gene lineage (parent + children) */
  async getGeneLineage(geneId: string): Promise<IMResult<{ geneId: string; parent?: IMGene; children: IMGene[]; generation: number }>> {
    return this._r('GET', `/api/im/evolution/public/genes/${geneId}/lineage`);
  }

  /** Get public evolution feed */
  async getFeed(limit?: number): Promise<IMResult<any[]>> {
    const query: Record<string, string> = {};
    if (limit != null) query.limit = String(limit);
    return this._r('GET', '/api/im/evolution/public/feed', undefined, query);
  }

  // ── Leaderboard V2 (public, no auth required) ──

  /** Get hero section global stats (total agents, genes, capsules, savings) */
  async getLeaderboardHero(): Promise<IMResult<any>> {
    return this._r('GET', '/api/im/evolution/leaderboard/hero');
  }

  /** Get rising stars leaderboard */
  async getLeaderboardRising(period?: string, limit?: number): Promise<IMResult<any[]>> {
    const query: Record<string, string> = {};
    if (period) query.period = period;
    if (limit != null) query.limit = String(limit);
    return this._r('GET', '/api/im/evolution/leaderboard/rising', undefined, query);
  }

  /** Get leaderboard summary stats (totalAgentsEvolving, totalGenesCreated, etc.) */
  async getLeaderboardStats(): Promise<IMResult<any>> {
    return this._r('GET', '/api/im/evolution/leaderboard/stats');
  }

  /** Get agent improvement board */
  async getLeaderboardAgents(period?: string, domain?: string): Promise<IMResult<any[]>> {
    const query: Record<string, string> = {};
    if (period) query.period = period;
    if (domain) query.domain = domain;
    return this._r('GET', '/api/im/evolution/leaderboard/agents', undefined, query);
  }

  /** Get gene impact board */
  async getLeaderboardGenes(period?: string, sort?: string): Promise<IMResult<any[]>> {
    const query: Record<string, string> = {};
    if (period) query.period = period;
    if (sort) query.sort = sort;
    return this._r('GET', '/api/im/evolution/leaderboard/genes', undefined, query);
  }

  /** Get contributor board */
  async getLeaderboardContributors(period?: string): Promise<IMResult<any[]>> {
    const query: Record<string, string> = {};
    if (period) query.period = period;
    return this._r('GET', '/api/im/evolution/leaderboard/contributors', undefined, query);
  }

  /** Get cross-environment comparison data */
  async getLeaderboardComparison(): Promise<IMResult<any>> {
    return this._r('GET', '/api/im/evolution/leaderboard/comparison');
  }

  /** Get public profile page data for an agent or owner */
  async getPublicProfile(entityId: string): Promise<IMResult<any>> {
    return this._r('GET', `/api/im/evolution/profile/${encodeURIComponent(entityId)}`);
  }

  /** Render agent/creator card as PNG */
  async renderCard(input: { type: string; agentId?: string; agentName?: string; [key: string]: unknown }): Promise<IMResult<any>> {
    return this._r('POST', '/api/im/evolution/card/render', input);
  }

  /** Get benchmark data for profile FOMO section */
  async getBenchmark(): Promise<IMResult<any>> {
    return this._r('GET', '/api/im/evolution/benchmark');
  }

  /** Get gene highlight capsules for profile page */
  async getHighlights(geneId: string): Promise<IMResult<any[]>> {
    return this._r('GET', `/api/im/evolution/highlights/${encodeURIComponent(geneId)}`);
  }

  // ── Authenticated endpoints ──

  /** Analyze signals and get gene recommendation */
  async analyze(options: IMAnalyzeOptions & { scope?: string }): Promise<IMResult<IMAnalyzeResult>> {
    const { scope, ...body } = options;
    const q: Record<string, string> = {};
    if (scope) q.scope = scope;
    return this._r('POST', '/api/im/evolution/analyze', body, q);
  }

  /** Record an outcome (success/failure) for a gene */
  async record(options: IMRecordOutcomeOptions & { scope?: string }): Promise<IMResult<any>> {
    const { scope, ...body } = options;
    const q: Record<string, string> = {};
    if (scope) q.scope = scope;
    return this._r('POST', '/api/im/evolution/record', body, q);
  }

  /**
   * One-step evolution: analyze context → get gene recommendation → auto-record outcome.
   * Combines analyze() + record() into a single call for the common case.
   *
   * Usage:
   *   const result = await client.evolution.evolve({
   *     error: 'Connection timeout after 10s',
   *     outcome: 'success',
   *     score: 0.85,
   *     summary: 'Fixed with exponential backoff',
   *   });
   */
  async evolve(options: {
    // analyze context (at least one required)
    error?: string;
    task_status?: string;
    task_capability?: string;
    tags?: string[];
    signals?: Array<string | { type: string; provider?: string; stage?: string; severity?: string }>;
    provider?: string;
    stage?: string;
    severity?: string;
    // outcome recording (required)
    outcome: 'success' | 'failed';
    score?: number;
    summary?: string;
    strategy_used?: string[];
    // shared
    scope?: string;
  }): Promise<IMResult<{ analysis: IMAnalyzeResult; recorded: boolean; edge_updated?: boolean }>> {
    const { outcome, score, summary, strategy_used, scope, ...analyzeOpts } = options;

    // 1. Analyze to get gene recommendation
    const analysis = await this.analyze({ ...(analyzeOpts as IMAnalyzeOptions), ...(scope ? { scope } : {}) });
    if (!analysis.ok || !analysis.data) {
      return { ok: false, ...(analysis.error ? { error: analysis.error } : {}) };
    }

    const data = analysis.data;
    const geneId = data.gene_id;

    // 2. If a gene was recommended, record the outcome
    if (geneId && (data.action === 'apply_gene' || data.action === 'explore')) {
      const recordResult = await this.record({
        gene_id: geneId,
        signals: data.signals || analyzeOpts.signals || [],
        outcome,
        score: score ?? (outcome === 'success' ? 0.8 : 0.2),
        summary: summary || `${outcome === 'success' ? 'Resolved' : 'Failed to resolve'} using ${geneId}`,
        strategy_used,
        ...(scope ? { scope } : {}),
      });

      return {
        ok: true,
        data: {
          analysis: data,
          recorded: true,
          edge_updated: recordResult.data?.edge_updated,
        },
      };
    }

    // 3. No gene matched — return analysis only (unmatched signals tracked server-side)
    return {
      ok: true,
      data: { analysis: data, recorded: false },
    };
  }

  /** Trigger gene distillation */
  async distill(dryRun?: boolean): Promise<IMResult<any>> {
    const query: Record<string, string> = {};
    if (dryRun) query.dry_run = 'true';
    return this._r('POST', '/api/im/evolution/distill', undefined, query);
  }

  /** List own genes */
  async listGenes(signals?: string, scope?: string): Promise<IMResult<IMGene[]>> {
    const query: Record<string, string> = {};
    if (signals) query.signals = signals;
    if (scope) query.scope = scope;
    return this._r('GET', '/api/im/evolution/genes', undefined, query);
  }

  /** Create a new gene */
  async createGene(options: IMCreateGeneOptions & { scope?: string }): Promise<IMResult<IMGene>> {
    const { scope, ...body } = options;
    const q: Record<string, string> = {};
    if (scope) q.scope = scope;
    return this._r('POST', '/api/im/evolution/genes', body, q);
  }

  /** Delete a gene */
  async deleteGene(geneId: string): Promise<IMResult<void>> {
    return this._r('DELETE', `/api/im/evolution/genes/${encodeURIComponent(geneId)}`);
  }

  /** Publish a gene. Pass skipCanary=true to bypass canary validation (MVP/admin). */
  async publishGene(geneId: string, options?: { skipCanary?: boolean }): Promise<IMResult<IMGene>> {
    return this._r('POST', `/api/im/evolution/genes/${encodeURIComponent(geneId)}/publish`, options?.skipCanary ? { skipCanary: true } : undefined);
  }

  /** Import a published gene */
  async importGene(geneId: string): Promise<IMResult<IMGene>> {
    return this._r('POST', '/api/im/evolution/genes/import', { gene_id: geneId });
  }

  /** Fork a gene with modifications */
  async forkGene(options: IMForkGeneOptions): Promise<IMResult<IMGene>> {
    return this._r('POST', '/api/im/evolution/genes/fork', options);
  }

  /** Get signal-gene edges */
  async getEdges(options?: { signalKey?: string; geneId?: string; limit?: number; scope?: string }): Promise<IMResult<IMEvolutionEdge[]>> {
    const query: Record<string, string> = {};
    if (options?.signalKey) query.signal_key = options.signalKey;
    if (options?.geneId) query.gene_id = options.geneId;
    if (options?.limit != null) query.limit = String(options.limit);
    if (options?.scope) query.scope = options.scope;
    return this._r('GET', '/api/im/evolution/edges', undefined, query);
  }

  /** Get agent personality profile */
  async getPersonality(agentId: string): Promise<IMResult<{ personality: IMAgentPersonality; stats: any }>> {
    return this._r('GET', `/api/im/evolution/personality/${agentId}`);
  }

  /** Get own capsule history */
  async getCapsules(options?: { page?: number; limit?: number; scope?: string }): Promise<IMResult<IMCapsule[]>> {
    const query: Record<string, string> = {};
    if (options?.page != null) query.page = String(options.page);
    if (options?.limit != null) query.limit = String(options.limit);
    if (options?.scope) query.scope = options.scope;
    return this._r('GET', '/api/im/evolution/capsules', undefined, query);
  }

  /** Get evolution report */
  async getReport(agentId?: string, scope?: string): Promise<IMResult<any>> {
    const query: Record<string, string> = {};
    if (agentId) query.agent_id = agentId;
    if (scope) query.scope = scope;
    return this._r('GET', '/api/im/evolution/report', undefined, query);
  }

  /** List available evolution scopes */
  async listScopes(): Promise<IMResult<string[]>> {
    return this._r('GET', '/api/im/evolution/scopes');
  }

  // ─── v0.3.1: Stories, Metrics, Skills ──────────────

  /** Get recent evolution stories (for L1 narrative embedding) */
  async getStories(options?: { limit?: number; since?: number }): Promise<IMResult<any[]>> {
    const query: Record<string, string> = {};
    if (options?.limit != null) query.limit = String(options.limit);
    if (options?.since != null) query.since = String(options.since);
    return this._r('GET', '/api/im/evolution/stories', undefined, query);
  }

  /** Get north-star metrics comparison (standard vs hypergraph) */
  async getMetrics(): Promise<IMResult<{ standard: any; hypergraph: any; verdict: string }>> {
    return this._r('GET', '/api/im/evolution/metrics');
  }

  /** Trigger metrics collection snapshot */
  async collectMetrics(windowHours?: number): Promise<IMResult<{ standard: any; hypergraph: any }>> {
    return this._r('POST', '/api/im/evolution/metrics/collect', { window_hours: windowHours ?? 1 });
  }

  /** Search skills catalog */
  async searchSkills(options?: IMSkillSearchOptions): Promise<IMResult<IMSkillInfo[]>> {
    return this.skills.search(options);
  }

  /** Get skill catalog stats */
  async getSkillStats(): Promise<IMResult<any>> {
    return this.skills.stats();
  }

  /** Install a skill — creates Gene + returns content + install guide */
  async installSkill(slugOrId: string, scope?: string): Promise<IMResult<IMSkillInstallResult>> {
    return this.skills.install(slugOrId, scope);
  }

  /** Uninstall a skill */
  async uninstallSkill(slugOrId: string, scope?: string): Promise<IMResult<{ uninstalled: boolean }>> {
    return this.skills.uninstall(slugOrId, scope);
  }

  /** List installed skills for this agent */
  async installedSkills(options?: IMAgentSkillListOptions): Promise<IMResult<IMAgentSkillRecord[]>> {
    return this.skills.installed(options);
  }

  /** Get full skill content (SKILL.md + package info) */
  async getSkillContent(slugOrId: string): Promise<IMResult<IMSkillContent>> {
    return this.skills.content(slugOrId);
  }

  /** Create/submit a community skill */
  async createSkill(input: IMSkillCreateInput): Promise<IMResult<IMSkillInfo & { content?: string }>> {
    return this.skills.create(input);
  }

  /** Star a skill (increment community rating) */
  async starSkill(skillId: string): Promise<IMResult<{ stars?: number }>> {
    return this.skills.star(skillId);
  }

  /**
   * Install a skill and write SKILL.md to local filesystem.
   * Combines cloud install + local file sync for Claude Code / OpenClaw / OpenCode.
   * @param slugOrId - Skill slug or ID
   * @param options - Local install options
   */
  async installSkillLocal(slugOrId: string, options?: {
    /** Target platforms (default: all detected) */
    platforms?: Array<'claude-code' | 'openclaw' | 'opencode' | 'plugin'>;
    /** Write to project-level paths instead of global */
    project?: boolean;
    /** Project root directory (for project-level installs) */
    projectRoot?: string;
  }): Promise<IMResult<IMSkillInstallResult & { localPaths: string[] }>> {
    // 1. Cloud install
    const result = await this.installSkill(slugOrId);
    if (!result.ok || !result.data) {
      // Propagate the typed error envelope; localPaths is absent on failure.
      return result as IMResult<IMSkillInstallResult & { localPaths: string[] }>;
    }

    const installData = result.data;
    // Build the "with localPaths" success envelope. We replace the `data`
    // field after the local-write phase decides what paths actually exist.
    const withLocalPaths = (
      localPaths: string[],
    ): IMResult<IMSkillInstallResult & { localPaths: string[] }> => ({
      ok: true,
      data: { ...installData, localPaths },
    });

    // 2. Get content (installSkill returns it directly when the cloud carries it).
    let content = installData.skill?.content || '';
    if (!content) {
      const contentResult = await this.getSkillContent(slugOrId);
      content = contentResult.data?.content || '';
    }
    if (!content) {
      return withLocalPaths([]);
    }

    // 3. Determine slug (sanitize to prevent path traversal)
    const rawSlug = installData.skill?.slug || slugOrId;
    const slug = rawSlug.replace(/[\/\\]/g, '').replace(/\.\./g, '');
    if (!slug) {
      return withLocalPaths([]);
    }

    // 4. Write to local paths
    const localPaths: string[] = [];
    // Need dynamic import for Node.js APIs (SDK may run in browser too)
    try {
      const { fs, path, os } = requireNodeBuiltins();
      const home = os.homedir();

      const pluginBase = process.env.PRISMER_PLUGIN_DIR || path.join(home, '.claude', 'plugins', 'prismer');
      type Platform = 'claude-code' | 'openclaw' | 'opencode' | 'plugin';
      const platformPaths: Record<Platform, string> = options?.project
        ? {
            'claude-code': path.join(options.projectRoot || '.', '.claude', 'skills', slug),
            'openclaw': path.join(options.projectRoot || '.', 'skills', slug),
            'opencode': path.join(options.projectRoot || '.', '.opencode', 'skills', slug),
            'plugin': path.join(options.projectRoot || '.', '.claude', 'plugins', 'prismer', 'skills', slug),
          }
        : {
            'claude-code': path.join(home, '.claude', 'skills', slug),
            'openclaw': path.join(home, '.openclaw', 'skills', slug),
            'opencode': path.join(home, '.config', 'opencode', 'skills', slug),
            'plugin': path.join(pluginBase, 'skills', slug),
          };

      const targets: Platform[] = options?.platforms ?? (Object.keys(platformPaths) as Platform[]);

      for (const platform of targets) {
        const dir = platformPaths[platform];
        if (!dir) continue;
        try {
          fs.mkdirSync(dir, { recursive: true });
          const filePath = path.join(dir, 'SKILL.md');
          fs.writeFileSync(filePath, content, 'utf-8');
          localPaths.push(filePath);
        } catch {
          // Skip if we can't write (e.g., permissions)
        }
      }
    } catch {
      // Not in Node.js environment — skip local writes
    }

    return withLocalPaths(localPaths);
  }

  /**
   * Uninstall a skill and remove local SKILL.md files.
   */
  async uninstallSkillLocal(slugOrId: string): Promise<IMResult<{ uninstalled: boolean; removedPaths: string[] }>> {
    const result = await this.uninstallSkill(slugOrId);
    const removedPaths: string[] = [];

    const withRemoved = (
      ok: boolean,
      paths: string[],
    ): IMResult<{ uninstalled: boolean; removedPaths: string[] }> => ({
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      data: { uninstalled: ok, removedPaths: paths },
    });

    // Sanitize slug to prevent path traversal
    const slug = safeSlug(slugOrId);
    if (!slug) return withRemoved(result.data?.uninstalled ?? false, removedPaths);

    try {
      const { fs, path, os } = requireNodeBuiltins();
      const home = os.homedir();

      const pluginBase = process.env.PRISMER_PLUGIN_DIR || path.join(home, '.claude', 'plugins', 'prismer');
      const dirs = [
        path.join(home, '.claude', 'skills', slug),
        path.join(home, '.openclaw', 'skills', slug),
        path.join(home, '.config', 'opencode', 'skills', slug),
        path.join(pluginBase, 'skills', slug),
      ];

      for (const dir of dirs) {
        try {
          if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true });
            removedPaths.push(dir);
          }
        } catch { /* skip */ }
      }
    } catch { /* not Node.js */ }

    return withRemoved(result.data?.uninstalled ?? false, removedPaths);
  }

  /**
   * Sync all installed skills to local filesystem.
   */
  async syncSkillsLocal(options?: {
    platforms?: Array<'claude-code' | 'openclaw' | 'opencode' | 'plugin'>;
  }): Promise<{ synced: number; failed: number; paths: string[] }> {
    const installed = await this.installedSkills();
    if (!installed.ok || !installed.data) return { synced: 0, failed: 0, paths: [] };

    let synced = 0;
    let failed = 0;
    const paths: string[] = [];

    type Platform = 'claude-code' | 'openclaw' | 'opencode' | 'plugin';

    for (const record of installed.data) {
      const rawSlug = record.skill?.slug;
      if (!rawSlug) { failed++; continue; }
      const slug = rawSlug.replace(/[\/\\]/g, '').replace(/\.\./g, '');
      if (!slug) { failed++; continue; }

      try {
        const contentResult = await this.getSkillContent(slug);
        const content = contentResult.data?.content;
        if (!content) { failed++; continue; }

        const { fs, path, os } = requireNodeBuiltins();
        const home = os.homedir();

        const pluginBase = process.env.PRISMER_PLUGIN_DIR || path.join(home, '.claude', 'plugins', 'prismer');
        const platformPaths: Record<Platform, string> = {
          'claude-code': path.join(home, '.claude', 'skills', slug),
          'openclaw': path.join(home, '.openclaw', 'skills', slug),
          'opencode': path.join(home, '.config', 'opencode', 'skills', slug),
          'plugin': path.join(pluginBase, 'skills', slug),
        };

        const targets: Platform[] = options?.platforms ?? (Object.keys(platformPaths) as Platform[]);
        for (const platform of targets) {
          const dir = platformPaths[platform];
          if (!dir) continue;
          try {
            fs.mkdirSync(dir, { recursive: true });
            const filePath = path.join(dir, 'SKILL.md');
            fs.writeFileSync(filePath, content, 'utf-8');
            paths.push(filePath);
          } catch { /* skip */ }
        }
        synced++;
      } catch {
        failed++;
      }
    }

    return { synced, failed, paths };
  }

  /** Export a Gene as a Skill */
  async exportAsSkill(geneId: string, options?: { slug?: string; displayName?: string; changelog?: string }): Promise<IMResult<any>> {
    return this._r('POST', `/api/im/evolution/genes/${geneId}/export-skill`, options);
  }

  // ─── P0: Report, Achievements, Sync ──────────────

  /** Submit a raw-context evolution report (auto-creates signals + gene match) */
  async submitReport(options: { rawContext: string; outcome: 'success' | 'failed'; taskContext?: string; taskError?: string; taskId?: string; metadata?: Record<string, unknown> }): Promise<IMResult<any>> {
    return this._r('POST', '/api/im/evolution/report', {
      raw_context: options.rawContext,
      outcome: options.outcome,
      task_context: options.taskContext,
      task_error: options.taskError,
      task_id: options.taskId,
      metadata: options.metadata,
    });
  }

  /** Get status of a submitted report by traceId */
  async getReportStatus(traceId: string): Promise<IMResult<any>> {
    return this._r('GET', `/api/im/evolution/report/${traceId}`);
  }

  /** Get evolution achievements for the current agent */
  async getAchievements(): Promise<IMResult<any[]>> {
    return this._r('GET', '/api/im/evolution/achievements');
  }

  /** Get a sync snapshot (global gene/edge state since a sequence number) */
  async getSyncSnapshot(since?: number): Promise<IMResult<any>> {
    const query: Record<string, string> = { scope: 'global' };
    if (since != null) query.since = String(since);
    return this._r('GET', '/api/im/evolution/sync/snapshot', undefined, query);
  }

  /**
   * Bidirectional sync: push local outcomes and pull remote updates.
   *
   * Accepts either the flat shape (`pushOutcomes` / `pullSince`) used by older
   * callers or the nested shape (`push` / `pull`) that mirrors the wire format
   * expected by `POST /api/im/evolution/sync`. The nested shape is preferred for
   * new code because it lets you pin a scope per-side.
   */
  async sync(options?: {
    pushOutcomes?: IMRecordOutcomeOptions[];
    pullSince?: number;
    push?: { outcomes?: IMRecordOutcomeOptions[]; scope?: string; workspaceId?: string };
    pull?: { since?: number; scope?: string };
    scope?: string;
  }): Promise<IMResult<{
    accepted?: number;
    rejected?: string[];
    pulled?: { genes?: IMGene[]; edges?: IMEvolutionEdge[]; cursor?: number };
    promotions?: string[];
    quarantines?: string[];
    priorAgg?: unknown;
  }>> {
    const body: Record<string, unknown> = {};
    const outcomes = options?.push?.outcomes ?? options?.pushOutcomes;
    if (outcomes) {
      body.push = {
        outcomes,
        ...(options?.push?.scope ? { scope: options.push.scope } : {}),
        ...(options?.push?.workspaceId ? { workspaceId: options.push.workspaceId } : {}),
      };
    }
    const since = options?.pull?.since ?? options?.pullSince;
    if (since != null) {
      body.pull = {
        since,
        ...(options?.pull?.scope ? { scope: options.pull.scope } : {}),
      };
    }
    const query: Record<string, string> = {};
    if (options?.scope) query.scope = options.scope;
    return this._r('POST', '/api/im/evolution/sync', body, query);
  }
}

/** Re-export v1.8.0 community module (cache + intents + REST). */
export { CommunityHub } from './community-hub';
export type { CommunityHubConfig } from './types';

/** Sanitize a slug/id to prevent path traversal (removes slashes, .., and null bytes) */
export function safeSlug(input: string): string {
  return input.replace(/[\/\\]/g, '').replace(/\.\./g, '').replace(/\0/g, '');
}

// ============================================================================
// v1.9.3 — Workspaces, Workspace Files, Assets, Runtime Installations
// ============================================================================

/**
 * Top-level workspace resource (v1.9.x). Different from the legacy
 * `WorkspaceClient` (which manages the 1.7-era `/workspace/init`,
 * `/workspace/init-group` superset bridge); 1.9.x workspaces are first-class
 * data containers backed by `IMWorkspace` rows.
 *
 * Most callers in 1.9.x have a single default workspace named "Personal" —
 * use `list()` and pick the row with `isDefault === true`.
 */
export class WorkspacesClient {
  readonly members: WorkspaceMembersClient;
  readonly invites: WorkspaceInvitesClient;

  constructor(private _r: RequestFn) {
    this.members = new WorkspaceMembersClient(_r);
    this.invites = new WorkspaceInvitesClient(_r);
  }

  /** List active workspaces owned by the caller. */
  async list(): Promise<IMResult<IMWorkspace[]>> {
    return this._r('GET', '/api/im/workspaces');
  }

  /**
   * Create a workspace. In 1.9.x most callers don't need this — registration
   * auto-creates a default workspace. The first workspace per owner is
   * always default; subsequent ones must omit `isDefault` (server returns 409).
   */
  async create(options: IMCreateWorkspaceOptions): Promise<IMResult<IMWorkspace>> {
    return this._r('POST', '/api/im/workspaces', options);
  }

  /** Daemon delta-sync workspaces since an ISO timestamp. */
  async sync(since?: string): Promise<IMResult<IMWorkspaceSyncResult>> {
    const query: Record<string, string> = {};
    if (since) query.since = since;
    return this._r('GET', '/api/im/workspaces/sync', undefined, query);
  }

  /** Get a single workspace by id (caller must own). */
  async get(workspaceId: string): Promise<IMResult<IMWorkspace>> {
    return this._r('GET', `/api/im/workspaces/${workspaceId}`);
  }

  /** Update workspace name and/or metadata. `slug` and `isDefault` are immutable in 1.9.x. */
  async update(workspaceId: string, options: IMUpdateWorkspaceOptions): Promise<IMResult<IMWorkspace>> {
    return this._r('PATCH', `/api/im/workspaces/${workspaceId}`, options);
  }

  /**
   * Archive (delete) a workspace. Server returns 405 in 1.9.x — workspace
   * deletion equals account close, which goes through `account.deleteAccount()`.
   * Provided for forward-compat; will become real in 1.10+.
   */
  async archive(workspaceId: string): Promise<IMResult<void>> {
    return this._r('DELETE', `/api/im/workspaces/${workspaceId}`);
  }

  /**
   * Get the workspace's orchestrator agent (Chief of Staff) — readable by any
   * member. Returns `{ workspace, orchestrator: null }` when no active
   * appointment exists. See release 200 §4.
   */
  async getOrchestrator(workspaceId: string): Promise<IMResult<IMWorkspaceOrchestratorEnvelope>> {
    return this._r('GET', `/api/im/workspaces/${workspaceId}/orchestrator`);
  }

  /**
   * Appoint an agent as the workspace's orchestrator. Owner-only.
   *
   * ⚠️ FIRST appointment only. The orchestrator is a node of the platform
   * network — it holds a globally-unique AIP identity (DID) and system contact
   * edges to the platform official agents — so the appointment is PERMANENT:
   * appointing a different agent while one is already in place fails with
   * 409 `ORCHESTRATOR_IMMUTABLE`. Re-appointing the same agent is a no-op.
   * Revocation does not exist (`revokeOrchestrator` was removed in 2.1.0).
   */
  async appointOrchestrator(
    workspaceId: string,
    agentImUserId: string,
  ): Promise<IMResult<{ orchestrator: IMWorkspaceOrchestrator | null }>> {
    return this._r('POST', `/api/im/workspaces/${workspaceId}/orchestrator`, { agentImUserId });
  }

  // Sub-clients `members` / `invites` are declared at the top of the class and
  // wired up inside the constructor body — see `AgentsClient` for the same
  // pattern. Declaring them as field initializers that reference `this._r`
  // hits TS2729 because parameter-property assignment happens after class
  // field initializers under `useDefineForClassFields`.
}

// ────────────────────────────────────────────────────────────────────────────
// Workspace Members (release201/16 Phase 8, v2.0.8)
// ────────────────────────────────────────────────────────────────────────────

/** Workspace membership role. Different enum from project (16 §5.1 decision). */
export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface IMWorkspaceMember {
  id: string;
  workspaceId: string;
  memberImUserId: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface WorkspaceMemberAddOptions {
  memberImUserId: string;
  /** 'owner' is rejected — use ownership transfer (v2.1+ RFC). */
  role: 'admin' | 'member';
}

export interface WorkspaceMemberRemoveResult {
  removed: IMWorkspaceMember;
  /** Project memberships cascade-removed in the same transaction (16 §3.2.3). */
  projectMembershipsRemoved: number;
}

/**
 * Workspace membership sub-client. Reached as `client.workspaces.members.*`.
 *
 * Endpoint semantics (16 §3.3.1):
 *   - list   : any workspace member (404 for non-members to prevent enumeration)
 *   - add    : owner only; role=owner rejected
 *   - update : owner only; promote-to-owner + demote-owner both rejected
 *   - remove : owner only; owner self-removal rejected; cascades project memberships
 */
export class WorkspaceMembersClient {
  constructor(private _r: RequestFn) {}

  async list(workspaceId: string): Promise<IMResult<IMWorkspaceMember[]>> {
    return this._r('GET', `/api/im/workspaces/${workspaceId}/members`);
  }

  async add(
    workspaceId: string,
    options: WorkspaceMemberAddOptions,
  ): Promise<IMResult<IMWorkspaceMember>> {
    return this._r('POST', `/api/im/workspaces/${workspaceId}/members`, options);
  }

  async update(
    workspaceId: string,
    memberId: string,
    options: { role: 'admin' | 'member' },
  ): Promise<IMResult<IMWorkspaceMember>> {
    return this._r('PATCH', `/api/im/workspaces/${workspaceId}/members/${memberId}`, options);
  }

  async remove(
    workspaceId: string,
    memberId: string,
  ): Promise<IMResult<WorkspaceMemberRemoveResult>> {
    return this._r('DELETE', `/api/im/workspaces/${workspaceId}/members/${memberId}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Workspace Invites (release201/16 Phase 9, v2.0.8)
// ────────────────────────────────────────────────────────────────────────────

/** Invite status. Terminal states are accepted | rejected | revoked | expired. */
export type WorkspaceInviteStatus = 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';

export type WorkspaceInviteRole = 'admin' | 'member';

export interface IMWorkspaceInvite {
  id: string;
  workspaceId: string;
  inviterUserId: string;
  /** Bearer token (URL-safe base64). Treat as a secret — log/redact accordingly. */
  token: string;
  inviteeEmail: string | null;
  inviteeImUserId: string | null;
  role: WorkspaceInviteRole;
  status: WorkspaceInviteStatus;
  expiresAt: string;
  acceptedByUserId: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceInviteCreateOptions {
  /** Pick one: emailed link OR direct-to-imUser request. */
  inviteeEmail?: string;
  inviteeImUserId?: string;
  /** Defaults to 'member' server-side. */
  role?: WorkspaceInviteRole;
  /** TTL in days. Defaults to 7; clamped server-side to [1, 30]. */
  expiresInDays?: number;
}

/**
 * Public preview surface. 16 §3.1.4 + §0.2.4: NEVER includes member count,
 * asset count, or workspace owner identity. Safe for unauthenticated reads.
 */
export interface WorkspaceInvitePreview {
  workspaceName: string;
  inviterDisplayName: string;
  inviterAvatar: string | null;
  role: WorkspaceInviteRole;
  status: WorkspaceInviteStatus;
  expiresAt: string;
}

/**
 * Workspace-scoped invite sub-client. Reached as `client.workspaces.invites.*`.
 *
 * Token-bearing endpoints (preview/accept/reject) live on `client.invites.*`
 * because the preview endpoint is public (no auth) — see `InvitesClient`.
 */
export class WorkspaceInvitesClient {
  constructor(private _r: RequestFn) {}

  async create(
    workspaceId: string,
    options: WorkspaceInviteCreateOptions,
  ): Promise<IMResult<IMWorkspaceInvite>> {
    return this._r('POST', `/api/im/workspaces/${workspaceId}/invites`, options);
  }

  async list(workspaceId: string): Promise<IMResult<IMWorkspaceInvite[]>> {
    return this._r('GET', `/api/im/workspaces/${workspaceId}/invites`);
  }

  async revoke(workspaceId: string, inviteId: string): Promise<IMResult<IMWorkspaceInvite>> {
    return this._r('DELETE', `/api/im/workspaces/${workspaceId}/invites/${inviteId}`);
  }
}

/**
 * Token-bearing invite sub-client. Reached as `client.invites.*`.
 *
 * `preview` is public; the client still uses the configured `request`
 * pipeline but server-side enforces no auth. Callers running in a
 * pre-login context should construct the SDK without an apiKey.
 */
export class InvitesClient {
  constructor(private _r: RequestFn) {}

  async preview(token: string): Promise<IMResult<WorkspaceInvitePreview>> {
    return this._r('GET', `/api/im/invites/${encodeURIComponent(token)}`);
  }

  async accept(token: string): Promise<IMResult<IMWorkspaceInvite>> {
    return this._r('POST', `/api/im/invites/${encodeURIComponent(token)}/accept`);
  }

  async reject(token: string): Promise<IMResult<IMWorkspaceInvite>> {
    return this._r('POST', `/api/im/invites/${encodeURIComponent(token)}/reject`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Projects (release201/09 Phase 1, v2.0.7)
// ────────────────────────────────────────────────────────────────────────────

/** Project status — 'active' = current; 'archived' = soft-deleted. */
export type ProjectStatus = 'active' | 'archived';

/** Membership role inside a project. */
export type ProjectMembershipRole = 'owner' | 'contributor' | 'observer';

/** Membership principal kind — covers both human and agent principals. */
export type ProjectPrincipalKind = 'user' | 'agent';

/** Soft-delete cascade strategy when removing a project. */
export type ProjectDeleteCascade = 'archive' | 'null' | 'hard';

export interface IMProject {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  ownerUserId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface IMProjectWithCounts extends IMProject {
  memberCount: number;
}

export interface IMProjectMembership {
  id: string;
  projectId: string;
  principalKind: ProjectPrincipalKind;
  principalId: string;
  role: ProjectMembershipRole;
  joinedAt: string;
}

export interface ProjectListResult {
  items: IMProjectWithCounts[];
  total: number;
}

export interface ProjectListOptions {
  workspaceId: string;
  status?: ProjectStatus;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ProjectCreateOptions {
  workspaceId: string;
  slug: string;
  name: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ProjectUpdateOptions {
  name?: string;
  description?: string | null;
  status?: ProjectStatus;
  metadata?: Record<string, unknown>;
}

export interface ProjectMemberAddOptions {
  principalKind: ProjectPrincipalKind;
  principalId: string;
  role?: ProjectMembershipRole;
}

/**
 * Project membership sub-client — bound to a parent ProjectsClient via the
 * shared RequestFn. Reached as `client.projects.members.*`.
 */

/** EaaS publishable key management (`/api/v1/projects/:id/publishable-keys`). */
export class EaasPublishableKeysClient {
  constructor(private readonly _r: RequestFn) {}

  async list(projectId: string, options?: { limit?: number }): Promise<EaasApiEnvelope<EaasPublishableKeyList>> {
    const query: Record<string, string> = {};
    if (options?.limit !== undefined) query.limit = String(options.limit);
    return this._r('GET', `/api/v1/projects/${encodeURIComponent(projectId)}/publishable-keys`, undefined, query);
  }

  async create(
    projectId: string,
    body: { name?: string; scopes?: string[] } = {},
  ): Promise<EaasApiEnvelope<EaasCreatedPublishableKey>> {
    return this._r('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/publishable-keys`, body);
  }

  async revoke(projectId: string, keyId: string): Promise<EaasApiEnvelope<EaasPublishableKeyRevokeResult>> {
    return this._r(
      'POST',
      `/api/v1/projects/${encodeURIComponent(projectId)}/publishable-keys/${encodeURIComponent(keyId)}/revoke`,
    );
  }
}

export class ProjectMembersClient {
  constructor(private _r: RequestFn) {}

  async list(projectId: string): Promise<IMResult<IMProjectMembership[]>> {
    return this._r('GET', `/api/im/projects/${projectId}/members`);
  }

  async add(
    projectId: string,
    options: ProjectMemberAddOptions,
  ): Promise<IMResult<IMProjectMembership>> {
    return this._r('POST', `/api/im/projects/${projectId}/members`, options);
  }

  async update(
    projectId: string,
    membershipId: string,
    options: { role: ProjectMembershipRole },
  ): Promise<IMResult<IMProjectMembership>> {
    return this._r('PATCH', `/api/im/projects/${projectId}/members/${membershipId}`, options);
  }

  async remove(projectId: string, membershipId: string): Promise<IMResult<void>> {
    return this._r('DELETE', `/api/im/projects/${projectId}/members/${membershipId}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// EaaS Warm Pool (eaas-gate-a Task 12 — `/api/v1/projects/:id/warm-pool`)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Warm pool policy sub-client — reached as `client.projects.warmPool.*`.
 *
 * Fail-through contract（测试焊死）：the server answers `503
 * warm_capacity_unavailable` when the pool is empty and `onMiss:'fail'`.
 * This client surfaces that envelope VERBATIM — no retry loop and no
 * automatic downgrade to a cold-start policy. The caller owns the decision
 * to retry（重试须传同一 `idempotencyKey`）or fall back to cold explicitly.
 */
export class WarmPoolClient {
  constructor(private readonly _r: RequestFn) {}

  async get(projectId: string): Promise<EaasApiEnvelope<WarmPoolStatus>> {
    return this._r('GET', `/api/v1/projects/${encodeURIComponent(projectId)}/warm-pool`);
  }

  /**
   * PATCH the desired policy. `revision` is sent as the If-Match header —
   * a BARE non-negative integer string（T8-(d) 服务端 parseIfMatch 只收裸整数，
   * 不接受 `W/"…"` 引号形态）。
   */
  async patch(
    projectId: string,
    body: { policy: WarmPoolPolicy; dryRun?: boolean },
    opts: { revision: number; idempotencyKey?: string },
  ): Promise<EaasApiEnvelope<WarmPoolStatus>> {
    return this._r(
      'PATCH',
      `/api/v1/projects/${encodeURIComponent(projectId)}/warm-pool`,
      { policy: body.policy, ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}) },
      undefined,
      {
        headers: {
          'If-Match': String(opts.revision),
          'Idempotency-Key': opts.idempotencyKey ?? newIdempotencyKey(),
        },
      },
    );
  }
}

/**
 * Projects API — release201/09 Phase 1 scope container above task.
 * Opt-in: workspaces without a project still work via NULL projectId on resources.
 */
export class PoolPolicyClient {
  constructor(private readonly _r: RequestFn) {}

  async get(projectId: string): Promise<EaasApiEnvelope<PoolPolicyStatus>> {
    return this._r('GET', `/api/v1/projects/${encodeURIComponent(projectId)}/pool-policy`);
  }

  /** Operator-only full replacement. dryRun validates without advancing revision. */
  async patch(
    projectId: string,
    body: { configRevision: string; policy: ProjectPoolManagement; dryRun?: boolean },
    opts: { revision: number; idempotencyKey?: string },
  ): Promise<EaasApiEnvelope<PoolPolicyStatus>> {
    return this._r('PATCH', `/api/v1/projects/${encodeURIComponent(projectId)}/pool-policy`, body, undefined, {
      headers: { 'If-Match': String(opts.revision), 'Idempotency-Key': opts.idempotencyKey ?? newIdempotencyKey() },
    });
  }
}

export class ProjectPoolsClient {
  constructor(private readonly _r: RequestFn) {}

  async list(projectId: string, opts: { cursor?: string; limit?: number } = {}): Promise<EaasApiEnvelope<ProjectPoolsPage>> {
    const query: Record<string, string> = {};
    if (opts.cursor !== undefined) query.cursor = opts.cursor;
    if (opts.limit !== undefined) query.limit = String(opts.limit);
    return this._r('GET', `/api/v1/projects/${encodeURIComponent(projectId)}/pools`, undefined, query);
  }
}

export class ProjectsClient {
  readonly members: ProjectMembersClient;
  /** EaaS warm pool policy surface (`/api/v1/projects/:id/warm-pool`). */
  readonly warmPool: WarmPoolClient;
  readonly poolPolicy: PoolPolicyClient;
  readonly pools: ProjectPoolsClient;
  /** EaaS publishable key management (`/api/v1/projects/:id/publishable-keys`). */
  readonly publishableKeys: EaasPublishableKeysClient;

  constructor(private _r: RequestFn, authorityRequest: RequestFn = _r) {
    this.members = new ProjectMembersClient(_r);
    this.warmPool = new WarmPoolClient(_r);
    this.poolPolicy = new PoolPolicyClient(authorityRequest);
    this.pools = new ProjectPoolsClient(authorityRequest);
    this.publishableKeys = new EaasPublishableKeysClient(_r);
  }

  async list(options: ProjectListOptions): Promise<IMResult<ProjectListResult>> {
    const query: Record<string, string> = { workspaceId: options.workspaceId };
    if (options.status) query.status = options.status;
    if (options.search) query.search = options.search;
    if (options.limit !== undefined) query.limit = String(options.limit);
    if (options.offset !== undefined) query.offset = String(options.offset);
    return this._r('GET', '/api/im/projects', undefined, query);
  }

  async create(options: ProjectCreateOptions): Promise<IMResult<IMProject>> {
    return this._r('POST', '/api/im/projects', options);
  }

  async get(projectId: string): Promise<IMResult<IMProjectWithCounts>> {
    return this._r('GET', `/api/im/projects/${projectId}`);
  }

  async update(
    projectId: string,
    options: ProjectUpdateOptions,
  ): Promise<IMResult<IMProject>> {
    return this._r('PATCH', `/api/im/projects/${projectId}`, options);
  }

  async delete(
    projectId: string,
    options?: { cascade?: ProjectDeleteCascade },
  ): Promise<IMResult<IMProject>> {
    const query: Record<string, string> = {};
    if (options?.cascade) query.cascade = options.cascade;
    return this._r('DELETE', `/api/im/projects/${projectId}`, undefined, query);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// EaaS Environments (eaas-gate-a Task 12 — `/api/v1/environments/*`)
// ────────────────────────────────────────────────────────────────────────────

/** Options for idempotency-keyed EaaS write calls. */
export interface EaasIdempotencyOptions {
  /**
   * Server dedup key (header `Idempotency-Key`). Auto-generated per call when
   * omitted. This SDK performs NO automatic retries — to safely retry a timed
   * out or failed write, the CALLER must pass the same `idempotencyKey` again;
   * a fresh key is treated by the server as a new operation.
   */
  idempotencyKey?: string;
}

/**
 * 非 200 响应 → fail envelope（fix round 1：FF off 裸 404 空 body / 网关 HTML
 * 错误页会让裸 `response.json()` 抛 SyntaxError——必须落回合成 envelope）。
 * body 为合法 error envelope 则原样透传；否则客户端合成 `http_error`
 * （与 `_request` 既有 fallback code 同名的客户端约定，非服务端
 * EAAS_ERROR_CODES 集合成员），requestId 无法取得时为空串。
 */
async function eaasFailFromResponse(response: Response, action: string): Promise<EaasFailEnvelope> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* empty body / HTML error page */
  }
  if (isEaasErrorEnvelope(body)) return body;
  return {
    success: false,
    error: { code: 'http_error', message: `${action} failed with status ${response.status}` },
    requestId: '',
  };
}

/**
 * EaaS environment lifecycle sub-client — reached as `client.environments.*`.
 *
 * Dual injection（PkfClient 同款模式）: `_r` carries the shared auth/retry
 * JSON pipeline for envelope calls; `_f` is the raw authenticated fetch seam
 * for the binary file face（PUT octet-stream bytes / GET raw bytes +
 * `X-Eaas-File-Sha256`）.
 */
export class EnvironmentsClient {
  constructor(
    private readonly _r: RequestFn,
    private readonly _f: (path: string, init?: RequestInit) => Promise<Response>,
  ) {}

  private _key(opts?: EaasIdempotencyOptions): string {
    return opts?.idempotencyKey ?? newIdempotencyKey();
  }


  /** Exchange a publishable key for a principal session (`POST /api/v1/sessions`). */
  async issueSession(body: EaasIssueSessionBody = {}): Promise<EaasApiEnvelope<EaasIssuedSession>> {
    return this._r('POST', '/api/v1/sessions', body);
  }

  /** Ensure the bound principal conversation with this environment's hosted agent. */
  async ensureConversation(id: string): Promise<EaasApiEnvelope<EaasConversationView>> {
    return this._r('POST', `/api/v1/environments/${encodeURIComponent(id)}/conversations`, {});
  }

  /** Start a separate conversation. Unlike ensureConversation, each call creates a new session. */
  async createConversation(id: string): Promise<EaasApiEnvelope<EaasConversationView>> {
    return this._r('POST', `/api/v1/environments/${encodeURIComponent(id)}/conversations`, { newConversation: true });
  }

  async listConversations(id: string): Promise<EaasApiEnvelope<EaasConversationList>> {
    return this._r('GET', `/api/v1/environments/${encodeURIComponent(id)}/conversations`);
  }

  async sendMessage(
    id: string,
    conversationId: string,
    body: { content: string; contentBlocks?: EaasContentBlockInput[]; answer?: EaasAnswerInput },
    opts?: EaasIdempotencyOptions,
  ): Promise<EaasApiEnvelope<EaasSendMessageResult>> {
    return this._r(
      'POST',
      `/api/v1/environments/${encodeURIComponent(id)}/conversations/${encodeURIComponent(conversationId)}/messages`,
      body,
      undefined,
      { headers: { 'Idempotency-Key': this._key(opts) } },
    );
  }

  async listMessages(
    id: string,
    conversationId: string,
    options?: { limit?: number },
  ): Promise<EaasApiEnvelope<EaasMessageList>> {
    const query: Record<string, string> = {};
    if (options?.limit !== undefined) query.limit = String(options.limit);
    return this._r(
      'GET',
      `/api/v1/environments/${encodeURIComponent(id)}/conversations/${encodeURIComponent(conversationId)}/messages`,
      undefined,
      query,
    );
  }

  async getRun(id: string, runId: string): Promise<EaasApiEnvelope<EaasRunView>> {
    return this._r('GET', `/api/v1/environments/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`);
  }

  async cancelRun(id: string, runId: string): Promise<EaasApiEnvelope<EaasRunCancelResult>> {
    return this._r('POST', `/api/v1/environments/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/cancel`);
  }

  async listRunEvents(
    id: string,
    runId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<EaasApiEnvelope<EaasRunEventPage>> {
    const query: Record<string, string> = {};
    if (options?.cursor !== undefined) query.cursor = options.cursor;
    if (options?.limit !== undefined) query.limit = String(options.limit);
    return this._r(
      'GET',
      `/api/v1/environments/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/events`,
      undefined,
      query,
    );
  }

  /**
   * List this caller's environment turn artifacts (oldest first). Operator/project
   * keys require files:read; principal sessions remain bound to their environment.
   * `limit` 整数 1..200，缺省 50；超出
   * `truncated: true`（无 cursor——翻页语义按 createdAt 全量窗口消费）。
   */
  async listArtifacts(id: string, options?: { limit?: number }): Promise<EaasApiEnvelope<EaasArtifactList>> {
    const query: Record<string, string> = {};
    if (options?.limit !== undefined) query.limit = String(options.limit);
    return this._r('GET', `/api/v1/environments/${encodeURIComponent(id)}/artifacts`, undefined, query);
  }

  /**
   * Download an artifact's content — raw bytes（不走 success envelope，与 getFile
   * 同款 raw seam）；`sha256` 取自 `X-Eaas-Artifact-Sha256` 响应头（与列表
   * contentHash 同源——服务端 sha256 完整性门背书）。失败走 envelope。
   */
  async getArtifact(id: string, artifactId: string): Promise<EaasArtifactGetResult> {
    const response = await this._f(
      `/api/v1/environments/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}`,
      { method: 'GET' },
    );
    if (!response.ok) return eaasFailFromResponse(response, 'artifact GET');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha256 = response.headers.get('x-eaas-artifact-sha256') ?? '';
    return { success: true, bytes, sha256 };
  }

  /**
   * Tenant-level event replay（默认 JSON Accept）— `GET /api/v1/events`。
   * `cursor` = 上一页 nextCursor（seq 字符串，0 起，缺省流头）；`limit` 正整数
   * ≤500 缺省 100；`environmentIds` / `projectIds` 逗号分隔过滤（principal
   * session 被服务端钉到直绑 env，显式过滤参数 → 400）。cursor 过期（prune
   * 后不可续传）→ 409 `state_conflict` envelope 原样透传，调用方走授权快照
   * resync 再重扫。
   */
  async listEvents(
    options?: { cursor?: string; limit?: number; environmentIds?: string[]; projectIds?: string[] },
  ): Promise<EaasApiEnvelope<EaasEventReplayPage>> {
    const query: Record<string, string> = {};
    if (options?.cursor !== undefined) query.cursor = options.cursor;
    if (options?.limit !== undefined) query.limit = String(options.limit);
    if (options?.environmentIds?.length) query.environmentIds = options.environmentIds.join(',');
    if (options?.projectIds?.length) query.projectIds = options.projectIds.join(',');
    return this._r('GET', '/api/v1/events', undefined, query);
  }

  async listSessions(id: string, options?: { limit?: number }): Promise<EaasApiEnvelope<EaasPrincipalSessionList>> {
    const query: Record<string, string> = {};
    if (options?.limit !== undefined) query.limit = String(options.limit);
    return this._r('GET', `/api/v1/environments/${encodeURIComponent(id)}/sessions`, undefined, query);
  }

  async revokeSession(
    id: string,
    sessionId: string,
  ): Promise<EaasApiEnvelope<EaasPrincipalSessionRevokeResult>> {
    return this._r(
      'POST',
      `/api/v1/environments/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}/revoke`,
    );
  }

  async issueAccessSession(
    id: string,
    body: EaasIssueAccessSessionBody,
    opts?: EaasIdempotencyOptions,
  ): Promise<EaasApiEnvelope<EaasIssuedAccessSession>> {
    return this._r('POST', `/api/v1/environments/${encodeURIComponent(id)}/access-sessions`, body, undefined, {
      headers: { 'Idempotency-Key': this._key(opts) },
    });
  }

  async listAccessSessions(
    id: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<EaasApiEnvelope<EaasPrincipalSessionList>> {
    const query: Record<string, string> = {};
    if (options?.limit !== undefined) query.limit = String(options.limit);
    if (options?.cursor !== undefined) query.cursor = options.cursor;
    return this._r('GET', `/api/v1/environments/${encodeURIComponent(id)}/access-sessions`, undefined, query);
  }

  async revokeAccessSession(
    id: string,
    sessionId: string,
  ): Promise<EaasApiEnvelope<EaasPrincipalSessionRevokeResult>> {
    return this._r(
      'POST',
      `/api/v1/environments/${encodeURIComponent(id)}/access-sessions/${encodeURIComponent(sessionId)}/revoke`,
    );
  }

  /** Create an environment → 202 + status projection（幂等键控）. */
  async create(
    spec: EnvironmentCreateSpec,
    opts?: EaasIdempotencyOptions,
  ): Promise<EaasApiEnvelope<EnvironmentStatus>> {
    return this._r('POST', '/api/v1/environments', spec, undefined, {
      headers: { 'Idempotency-Key': this._key(opts) },
    });
  }

  async get(id: string): Promise<EaasApiEnvelope<EnvironmentStatus>> {
    return this._r('GET', `/api/v1/environments/${encodeURIComponent(id)}`);
  }

  async list(options?: { cursor?: string; limit?: number }): Promise<EaasApiEnvelope<EnvironmentListPage>> {
    const query: Record<string, string> = {};
    if (options?.cursor !== undefined) query.cursor = options.cursor;
    if (options?.limit !== undefined) query.limit = String(options.limit);
    return this._r('GET', '/api/v1/environments', undefined, query);
  }

  /** PATCH expiresAt/metadata. `revision` → If-Match（裸整数，同 warmPool.patch）。 */
  async update(
    id: string,
    body: { expiresAt?: string; metadata?: Record<string, string> },
    opts: { revision: number },
  ): Promise<EaasApiEnvelope<EnvironmentStatus>> {
    return this._r('PATCH', `/api/v1/environments/${encodeURIComponent(id)}`, body, undefined, {
      headers: { 'If-Match': String(opts.revision) },
    });
  }

  async delete(id: string, opts?: EaasIdempotencyOptions): Promise<EaasApiEnvelope<EaasLifecycleResult>> {
    return this._r('DELETE', `/api/v1/environments/${encodeURIComponent(id)}`, undefined, undefined, {
      headers: { 'Idempotency-Key': this._key(opts) },
    });
  }

  async pause(id: string, opts?: EaasIdempotencyOptions): Promise<EaasApiEnvelope<EaasLifecycleResult>> {
    return this._r('POST', `/api/v1/environments/${encodeURIComponent(id)}/pause`, undefined, undefined, {
      headers: { 'Idempotency-Key': this._key(opts) },
    });
  }

  async wake(id: string, opts?: EaasIdempotencyOptions): Promise<EaasApiEnvelope<EaasLifecycleResult>> {
    return this._r('POST', `/api/v1/environments/${encodeURIComponent(id)}/wake`, undefined, undefined, {
      headers: { 'Idempotency-Key': this._key(opts) },
    });
  }

  async suspend(id: string, opts?: EaasIdempotencyOptions): Promise<EaasApiEnvelope<EaasLifecycleResult>> {
    return this._r('POST', `/api/v1/environments/${encodeURIComponent(id)}/suspend`, undefined, undefined, {
      headers: { 'Idempotency-Key': this._key(opts) },
    });
  }

  /** Synchronous-window exec（幂等键控；A1 句柄语义由服务端裁定 200/202）。 */
  async exec(
    id: string,
    command: { command: string[]; timeoutMs?: number },
    opts?: EaasIdempotencyOptions,
  ): Promise<EaasApiEnvelope<EaasExecView>> {
    return this._r(
      'POST',
      `/api/v1/environments/${encodeURIComponent(id)}/execs`,
      command,
      undefined,
      { headers: { 'Idempotency-Key': this._key(opts) } },
    );
  }

  /** Read an exec handle; `cursor` = stdout byte offset for paged reads. */
  async getExec(
    id: string,
    execId: string,
    options?: { cursor?: number },
  ): Promise<EaasApiEnvelope<EaasExecReadView>> {
    const query: Record<string, string> = {};
    if (options?.cursor !== undefined) query.cursor = String(options.cursor);
    return this._r(
      'GET',
      `/api/v1/environments/${encodeURIComponent(id)}/execs/${encodeURIComponent(execId)}`,
      undefined,
      query,
    );
  }

  /** PUT raw octet-stream bytes（≤1MB，服务端限额）；返回 sha256 供核对。 */
  async putFile(id: string, path: string, bytes: Uint8Array): Promise<EaasApiEnvelope<EaasFilePutView>> {
    const response = await this._f(this._filePath(id, path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      // fetch accepts any ArrayBufferView at runtime; the cast only bridges
      // TS 5.7+ `Uint8Array<ArrayBufferLike>` vs the lib's `BodyInit` narrowing.
      body: bytes as unknown as BodyInit,
    });
    if (!response.ok) return eaasFailFromResponse(response, 'file PUT');
    return (await response.json()) as EaasApiEnvelope<EaasFilePutView>;
  }

  /**
   * 上传图片 asset（多模态输入前门）：字节落本 env carrier workspace，
   * contentHash 去重（同字节重传幂等返回既有 assetId）。返回的 assetId 供
   * `sendMessage` 的 `contentBlocks` 引用。≤5MB，mediaType 必须命中 raster 白名单
   * （`image/png|jpeg|webp|gif`；`image/jpg` 视作 jpeg 别名），且首字节须与声明型
   * 一致——`image/svg+xml` 等非 raster 型一律 400 `invalid_request`（存储 mime 取
   * 服务端派生的 canonical 形）。
   */
  async uploadAsset(
    id: string,
    bytes: Uint8Array,
    mediaType = 'image/png',
  ): Promise<EaasApiEnvelope<EaasAssetUploadResult>> {
    const response = await this._f(`/api/v1/environments/${encodeURIComponent(id)}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': mediaType },
      body: bytes as unknown as BodyInit,
    });
    if (!response.ok) return eaasFailFromResponse(response, 'asset upload');
    return (await response.json()) as EaasApiEnvelope<EaasAssetUploadResult>;
  }

  /** GET raw bytes；`sha256` 取自 `X-Eaas-File-Sha256` 响应头。失败走 envelope。 */
  async getFile(id: string, path: string): Promise<EaasFileGetResult> {
    const response = await this._f(this._filePath(id, path), { method: 'GET' });
    if (!response.ok) return eaasFailFromResponse(response, 'file GET');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha256 = response.headers.get('x-eaas-file-sha256') ?? '';
    return { success: true, bytes, sha256 };
  }

  /** Create a snapshot（幂等键控 → 202 pending op，reconcile 执行 port.snapshot）。 */
  async createSnapshot(id: string, opts?: EaasIdempotencyOptions): Promise<EaasApiEnvelope<EaasSnapshotCreated>> {
    return this._r(
      'POST',
      `/api/v1/environments/${encodeURIComponent(id)}/snapshots`,
      undefined,
      undefined,
      { headers: { 'Idempotency-Key': this._key(opts) } },
    );
  }

  async listSnapshots(id: string): Promise<EaasApiEnvelope<EaasSnapshotList>> {
    return this._r('GET', `/api/v1/environments/${encodeURIComponent(id)}/snapshots`);
  }

  async restore(
    id: string,
    snapshotId: string,
    opts?: EaasIdempotencyOptions,
  ): Promise<EaasApiEnvelope<EaasLifecycleResult>> {
    return this._r(
      'POST',
      `/api/v1/environments/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
      undefined,
      undefined,
      { headers: { 'Idempotency-Key': this._key(opts) } },
    );
  }

  /**
   * Service readiness projection. `gatewayUrl` is a HMAC-signed scoped gateway URL
   * （Gate B T10 签发面；principal 通道内嵌 session 直绑 principalId）——绝不暴露 Pod IP；
   * 消费它的 Gateway 转发服务仍是 Gate B+ 交付面。
   */
  async listServices(id: string): Promise<EaasApiEnvelope<EaasServicesProjection>> {
    return this._r('GET', `/api/v1/environments/${encodeURIComponent(id)}/services`);
  }

  /**
   * Read the project metering ledger — `GET /api/v1/projects/:id/usage`（Gate B
   * T19；operator 面，principal session 打上按 project 归属 403/404）. Window is
   * `[from, to)` ISO timestamps (default: the current UTC day, capped at 31
   * days), `limit` defaults to 100 and clamps to 500, `cursor` resumes from the
   * previous page's `nextCursor`.
   */
  async usage(
    projectId: string,
    options?: { from?: string; to?: string; cursor?: string; limit?: number },
  ): Promise<EaasApiEnvelope<EaasUsagePage>> {
    const query: Record<string, string> = {};
    if (options?.from !== undefined) query.from = options.from;
    if (options?.to !== undefined) query.to = options.to;
    if (options?.cursor !== undefined) query.cursor = options.cursor;
    if (options?.limit !== undefined) query.limit = String(options.limit);
    return this._r('GET', `/api/v1/projects/${encodeURIComponent(projectId)}/usage`, undefined, query);
  }


  /**
   * Read the project billing projection — `GET /api/v1/projects/:id/billing`.
   * Human/operator billing face only. Rows are derived from immutable usage rows
   * and joined to the credit transaction ledger by `eaas:usage:{id}:{rateVersion}`.
   */
  async billing(
    projectId: string,
    options?: { from?: string; to?: string; cursor?: string; limit?: number },
  ): Promise<EaasApiEnvelope<EaasBillingPage>> {
    const query: Record<string, string> = {};
    if (options?.from !== undefined) query.from = options.from;
    if (options?.to !== undefined) query.to = options.to;
    if (options?.cursor !== undefined) query.cursor = options.cursor;
    if (options?.limit !== undefined) query.limit = String(options.limit);
    return this._r('GET', `/api/v1/projects/${encodeURIComponent(projectId)}/billing`, undefined, query);
  }

  /**
   * Poll `get()` until `readiness[capability]` flips true（readiness 驱动）.
   * `capability: 'agent'` rejects IMMEDIATELY with `capability_unavailable`
   * （Gate A 不探 agent readiness，绝不轮询）. Timeout → `EaasClientError`
   * with code `'timeout'`；poll 命中 fail envelope → 以服务端 code/message reject.
   */
  async waitUntilReady(
    id: string,
    options?: { capability?: 'services' | 'agent'; timeoutMs?: number; pollMs?: number },
  ): Promise<EnvironmentStatus> {
    const capability = options?.capability ?? 'services';
    if (capability === 'agent') {
      throw new EaasClientError(
        'capability_unavailable',
        "capability 'agent' is not available in Gate A (only 'services' is readiness-driven)",
      );
    }
    const timeoutMs = options?.timeoutMs ?? 120000;
    const pollMs = options?.pollMs ?? 1000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await this.get(id);
      if (!res.success) {
        throw new EaasClientError(res.error.code, res.error.message);
      }
      if (res.data.readiness[capability]) {
        return res.data;
      }
      if (Date.now() >= deadline) {
        throw new EaasClientError(
          'timeout',
          `waitUntilReady: capability '${capability}' not ready within ${timeoutMs}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  private _filePath(id: string, path: string): string {
    // Catch-all `[...path]` route — each segment encoded individually.
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return `/api/v1/environments/${encodeURIComponent(id)}/files/${encoded}`;
  }
}

export class EaasClient {
  constructor(private readonly _r: RequestFn) {}

  /** Discover the authenticated EaaS credential, project defaults and visible limits. */
  async context(): Promise<EaasApiEnvelope<EaasContextProjection>> {
    return this._r('GET', '/api/v1/context');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// EaaS Skills (Gate B T8 — `/api/v1/skills`, tenant-private skill catalog)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Tenant-private skill catalog — operator-only CRUD + publish face
 * (`/api/v1/skills/*`, src/tenant/skill-catalog.ts)。Reached as
 * `client.eaasSkills.*`（tenant-scoped：路径无 env/project 段，与 IM 面
 * `SkillsClient` 同名不同物）。机器 key 无管理面（403）、principal 由 route
 * 壳判别 403/404；本面不要求 Idempotency-Key（发布去重由审批 operationKey
 * 承担，CRUD 为直接态翻转——服务端 route 声明）。
 */
export class EaasMemoriesClient {
  constructor(private readonly _r: RequestFn) {}

  write(body: EaasMemoryWriteBody, opts?: EaasIdempotencyOptions & { environmentId?: string }): Promise<EaasApiEnvelope<EaasMemoryWriteResult>> {
    const path = opts?.environmentId === undefined ? '/api/v1/memories'
      : `/api/v1/environments/${encodeURIComponent(opts.environmentId)}/memories`;
    return this._r('POST', path, body, undefined, {
      headers: { 'Idempotency-Key': opts?.idempotencyKey ?? newIdempotencyKey() },
    });
  }

  search(opts: { query?: string; limit?: number; environmentId?: string } = {}): Promise<EaasApiEnvelope<EaasMemorySearchResult>> {
    const path = opts.environmentId === undefined ? '/api/v1/memories'
      : `/api/v1/environments/${encodeURIComponent(opts.environmentId)}/memories`;
    return this._r('GET', path, undefined, {
      ...(opts.query === undefined ? {} : { q: opts.query }),
      ...(opts.limit === undefined ? {} : { limit: String(opts.limit) }),
    });
  }

  grantEnvironment(id: string): Promise<EaasApiEnvelope<EaasMemoryGrantResult>> {
    return this._r('POST', `/api/v1/environments/${encodeURIComponent(id)}/memories/grants`);
  }

  revokeEnvironment(id: string): Promise<EaasApiEnvelope<EaasMemoryGrantResult>> {
    return this._r('DELETE', `/api/v1/environments/${encodeURIComponent(id)}/memories/grants`);
  }
}

export class EaasSkillsClient {
  constructor(private readonly _r: RequestFn) {}

  /** List tenant skills（createdAt desc，服务端 take 200）；`status` 过滤 private|published。 */
  async list(options?: { status?: 'private' | 'published' }): Promise<EaasApiEnvelope<EaasPrivateSkillList>> {
    const query: Record<string, string> = {};
    if (options?.status) query.status = options.status;
    return this._r('GET', '/api/v1/skills', undefined, query);
  }

  /** Create a private skill（slug 租户内唯一，撞唯一键 → 409 state_conflict；SK-11 metadata-only 拒 400）。 */
  async create(body: EaasPrivateSkillCreateBody): Promise<EaasApiEnvelope<EaasPrivateSkillView>> {
    return this._r('POST', '/api/v1/skills', body);
  }

  /** Read one skill — list 投影 + content 全文。 */
  async get(id: string): Promise<EaasApiEnvelope<EaasPrivateSkillDetail>> {
    return this._r('GET', `/api/v1/skills/${encodeURIComponent(id)}`);
  }

  /** Partial update（name/description/content/contentManifest/license；更新后仍须过 SK-11）。 */
  async update(id: string, body: EaasPrivateSkillUpdateBody): Promise<EaasApiEnvelope<EaasPrivateSkillView>> {
    return this._r('PATCH', `/api/v1/skills/${encodeURIComponent(id)}`, body);
  }

  async delete(id: string): Promise<EaasApiEnvelope<EaasSkillDeleteResult>> {
    return this._r('DELETE', `/api/v1/skills/${encodeURIComponent(id)}`);
  }

  /**
   * private → published 走 marketplace 人类授权门（A2 §4.3）：operator 成员
   * 请求 → 202 pending_approval（owner DM 审批）；owner 本人 → 200 passthrough
   * 直翻；已 published → 幂等 200。审批已被 decided 的 replay → 409
   * state_conflict 原样透传。
   */
  async publish(id: string): Promise<EaasApiEnvelope<EaasSkillPublishResult>> {
    return this._r('POST', `/api/v1/skills/${encodeURIComponent(id)}/publish`);
  }
}

/**
 * Workspace files (v1.9.3). Each file is a `path → assetId` binding inside a
 * workspace. POST is auto-versioning: the previous binding at the same path
 * is soft-deleted, version bumps, and `parentVersionId` chains the history.
 */
export class WorkspaceFilesClient {
  constructor(private _r: RequestFn) {}

  /** List the active file tree for a workspace, or look up a single file by path. */
  async list(workspaceId: string, options?: { path?: string }): Promise<IMResult<IMWorkspaceFile[] | IMWorkspaceFile>> {
    const query: Record<string, string> = {};
    if (options?.path) query.path = options.path;
    return this._r('GET', `/api/im/workspaces/${workspaceId}/files`, undefined, query);
  }

  /**
   * Bind `path → assetId`. Idempotent if `(path, assetId)` matches the existing
   * active binding. Asset must already exist in the same workspace.
   */
  async create(workspaceId: string, options: IMCreateWorkspaceFileOptions): Promise<IMResult<IMWorkspaceFile>> {
    return this._r('POST', `/api/im/workspaces/${workspaceId}/files`, options);
  }

  /** Soft-delete the active binding at `path`. */
  async delete(workspaceId: string, path: string): Promise<IMResult<void>> {
    return this._r('DELETE', `/api/im/workspaces/${workspaceId}/files`, undefined, { path });
  }

  /** Daemon delta-sync workspace files since an ISO timestamp. */
  async sync(workspaceId: string, since?: string): Promise<IMResult<IMWorkspaceFileSyncResult>> {
    const query: Record<string, string> = {};
    if (since) query.since = since;
    return this._r('GET', `/api/im/workspaces/${workspaceId}/files/sync`, undefined, query);
  }

  /** Get the version chain for a file (walks `parentVersionId`). */
  async history(workspaceId: string, fileId: string): Promise<IMResult<IMWorkspaceFile[]>> {
    return this._r('GET', `/api/im/workspaces/${workspaceId}/files/${fileId}/history`);
  }
}

const MAX_IM_ASSET_BYTES = 1024 * 1024 * 1024;
const DIRECT_ASSET_UPLOAD_FALLBACK_STATUSES = new Set([404, 501, 503]);

type NormalizedAssetUploadInput = {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
};

type DirectAssetUploadPlan =
  | {
      mode: 'single';
      bucket: string;
      key: string;
      uploadUrl: string;
      method?: string;
      headers?: Record<string, string>;
    }
  | {
      mode: 'multipart';
      bucket: string;
      key: string;
      uploadId: string;
      partSizeBytes: number;
      parts: Array<{ partNumber: number; url: string }>;
    };

type DirectAssetUploadInitResponse = DirectAssetUploadPlan & {
  contentHash?: string;
  sizeBytes?: number;
  mime?: string | null;
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', ab);
    return toHex(new Uint8Array(digest));
  }
  const nodeCrypto = nodeBuiltin<{ createHash: (a: string) => { update(b: Uint8Array): { digest(e: string): string } } }>('crypto');
  if (nodeCrypto) return nodeCrypto.createHash('sha256').update(bytes).digest('hex');
  throw new Error('no SHA-256 available (neither globalThis.crypto nor Node crypto)');
}

function bytesToBlob(bytes: Uint8Array, mimeType: string): Blob {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Blob([ab], { type: mimeType });
}

function isNamedFile(input: Blob): input is File {
  return typeof File !== 'undefined' && input instanceof File;
}

function normalizeStringHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isDirectAssetUploadPlan(value: unknown): value is DirectAssetUploadInitResponse {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Record<string, unknown>;
  if (plan.mode === 'single') {
    return typeof plan.uploadUrl === 'string' && typeof plan.bucket === 'string' && typeof plan.key === 'string';
  }
  if (plan.mode === 'multipart') {
    return (
      typeof plan.bucket === 'string' &&
      typeof plan.key === 'string' &&
      typeof plan.uploadId === 'string' &&
      typeof plan.partSizeBytes === 'number' &&
      Array.isArray(plan.parts) &&
      plan.parts.every((part) => {
        const item = part as Record<string, unknown>;
        return typeof item.url === 'string' && Number.isInteger(item.partNumber);
      })
    );
  }
  return false;
}

function assetUploadError(code: string, message: string): IMResult<IMAsset> {
  return { ok: false, error: { code, message } };
}

async function normalizeAssetUploadInput(input: FileInput, options: IMAssetUploadOptions): Promise<NormalizedAssetUploadInput> {
  let bytes: Uint8Array;
  let fileName: string;

  if (typeof input === 'string') {
    const { fs, path } = requireNodeBuiltins();
    const buf = await fs.promises.readFile(input);
    bytes = new Uint8Array(buf);
    fileName = options.fileName || path.basename(input);
  } else if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const ab = await input.arrayBuffer();
    bytes = new Uint8Array(ab);
    fileName = options.fileName || (isNamedFile(input) ? input.name : '');
    if (!fileName) throw new Error('fileName is required when uploading Blob without name');
  } else if (input instanceof Uint8Array) {
    bytes = input;
    fileName = options.fileName || '';
    if (!fileName) throw new Error('fileName is required when uploading Buffer or Uint8Array');
  } else {
    throw new Error('Unsupported input type');
  }

  const sizeBytes = bytes.byteLength;
  if (sizeBytes > MAX_IM_ASSET_BYTES) {
    throw new Error('Asset exceeds 1 GB cap');
  }

  const mimeType = options.mimeType || guessMimeType(fileName);
  const contentHash = await sha256BytesHex(bytes);
  return { bytes, fileName, mimeType, sizeBytes, contentHash };
}

/**
 * Assets (v1.9.3). Content-addressed immutable blobs (sha256). Same hash +
 * same workspace dedupes to a single row. The `prismer://<owner>/asset/<sha>`
 * URI is resolved by the existing Load API (`/api/context/load`) — see
 * `client.load()` for that path.
 */
export class AssetsClient {
  constructor(
    private _r: RequestFn,
    private _baseUrl: string,
    private _fetchFn: typeof fetch,
    private _getAuthHeaders: () => Record<string, string>,
  ) {}

  /** List assets in a workspace (filterable by task and kind). */
  async list(options: IMAssetListOptions): Promise<IMResult<IMAsset[]>> {
    const query: Record<string, string> = {};
    if (options.workspaceId) query.workspaceId = options.workspaceId;
    if (options.taskId) query.taskId = options.taskId;
    if (options.kind) query.kind = options.kind;
    if (options.limit != null) query.limit = String(options.limit);
    return this._r('GET', '/api/im/assets', undefined, query);
  }

  /**
   * Look up an asset by content hash within a workspace. Useful for dedupe
   * checks ("do I already have this file?") before uploading.
   */
  async byHash(hash: string, workspaceId: string): Promise<IMResult<IMAsset>> {
    return this._r('GET', `/api/im/assets/by-hash/${encodeURIComponent(hash)}`, undefined, { wsId: workspaceId });
  }

  /**
   * Get full asset metadata + a freshly-signed URL (5 min TTL, S3 backend only).
   * For `kind === 'photo-memory-segment'` this also includes a `photoRefs`
   * reverse-lookup of memory references.
   */
  async detail(assetId: string): Promise<IMResult<IMAssetDetail>> {
    return this._r('GET', `/api/im/assets/${assetId}/detail`);
  }

  /**
   * Soft-delete an asset (the underlying S3 object is retained). Idempotent.
   */
  async delete(assetId: string): Promise<IMResult<void>> {
    return this._r('DELETE', `/api/im/assets/${assetId}`);
  }

  /**
   * Build a download URL for an asset. Filesystem backend streams bytes
   * directly; S3 backend returns a 302 to a 5-minute presigned URL.
   * Use `download()` for a one-shot fetch returning bytes.
   */
  url(assetId: string): string {
    return `${this._baseUrl}/api/im/assets/${assetId}`;
  }

  /**
   * Download an asset's bytes. Authentication is forwarded; for S3 backend
   * the server returns a 302 which `fetch` follows automatically.
   */
  async download(assetId: string): Promise<{ bytes: Uint8Array; mime: string | null; sizeBytes: number | null }> {
    const resp = await this._fetchFn(this.url(assetId), {
      method: 'GET',
      headers: this._getAuthHeaders(),
    });
    if (!resp.ok) {
      throw new Error(`Asset download failed (${resp.status}): ${await resp.text()}`);
    }
    const ab = await resp.arrayBuffer();
    const sizeHeader = resp.headers.get('content-length');
    return {
      bytes: new Uint8Array(ab),
      mime: resp.headers.get('content-type'),
      sizeBytes: sizeHeader ? Number(sizeHeader) : null,
    };
  }

  /**
   * Upload bytes as an asset. Uses direct-to-S3 upload when the server exposes
   * `/assets/direct-upload/*`; falls back to legacy multipart POST for local
   * filesystem mode and older deployments. The client always sends SHA-256 for
   * server-side byte integrity checks. Hard cap: 1 GB.
   */
  async upload(input: FileInput, options: IMAssetUploadOptions): Promise<IMResult<IMAsset>> {
    const normalized = await normalizeAssetUploadInput(input, options);
    const direct = await this._tryDirectUpload(normalized, options);
    if (direct) return direct;
    return this._uploadMultipart(normalized, options);
  }

  private async _tryDirectUpload(
    file: NormalizedAssetUploadInput,
    options: IMAssetUploadOptions,
  ): Promise<IMResult<IMAsset> | null> {
    const init = await this._postAssetJson<DirectAssetUploadInitResponse>('/direct-upload/init', {
      workspaceId: options.workspaceId,
      filename: file.fileName,
      mime: file.mimeType,
      sizeBytes: file.sizeBytes,
      contentHash: file.contentHash,
    });

    if (!init.response.ok) {
      if (DIRECT_ASSET_UPLOAD_FALLBACK_STATUSES.has(init.response.status)) return null;
      return init.data && init.data.ok === false
        ? {
            ok: false,
            error: init.data.error ?? {
              code: 'http_error',
              message: `Direct upload init failed (${init.response.status})`,
            },
          }
        : assetUploadError('http_error', `Direct upload init failed (${init.response.status})`);
    }
    if (!isDirectAssetUploadPlan(init.data?.data)) return null;

    const plan = init.data.data;
    try {
      const parts = await this._putDirectUploadBytes(plan, file, options.onProgress);
      const complete = await this._postAssetJson<IMAsset>('/direct-upload/complete', {
        workspaceId: options.workspaceId,
        filename: file.fileName,
        mime: file.mimeType,
        sizeBytes: file.sizeBytes,
        contentHash: file.contentHash,
        kind: options.kind,
        metadata: options.metadata,
        sourceTaskId: options.sourceTaskId,
        sourceAgentImUserId: options.sourceAgentImUserId,
        bucket: plan.bucket,
        key: plan.key,
        ...(plan.mode === 'multipart' ? { uploadId: plan.uploadId, parts: parts ?? [] } : {}),
      });
      if (!complete.response.ok) {
        return complete.data && complete.data.ok === false
          ? complete.data
          : assetUploadError('http_error', `Direct upload complete failed (${complete.response.status})`);
      }
      if (!complete.data) {
        return assetUploadError('invalid_response', 'Direct upload complete returned an empty response');
      }
      return complete.data;
    } catch {
      return null;
    }
  }

  private async _postAssetJson<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ response: Response; data: IMResult<T> | null }> {
    const response = await this._fetchFn(`${this._baseUrl}/api/im/assets${path}`, {
      method: 'POST',
      headers: {
        ...this._getAuthHeaders(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null) as IMResult<T> | null;
    return { response, data };
  }

  private async _putDirectUploadBytes(
    plan: DirectAssetUploadPlan,
    file: NormalizedAssetUploadInput,
    onProgress?: (uploaded: number, total: number) => void,
  ): Promise<Array<{ partNumber: number; etag: string }> | null> {
    if (plan.mode === 'single') {
      const response = await this._fetchFn(plan.uploadUrl, {
        method: plan.method ?? 'PUT',
        headers: normalizeStringHeaders(plan.headers),
        body: bytesToBlob(file.bytes, file.mimeType),
      });
      if (!response.ok) throw new Error(`signed PUT failed (${response.status})`);
      onProgress?.(file.sizeBytes, file.sizeBytes);
      return null;
    }

    const completedParts: Array<{ partNumber: number; etag: string }> = [];
    let uploaded = 0;
    for (const part of plan.parts) {
      const start = (part.partNumber - 1) * plan.partSizeBytes;
      const end = Math.min(start + plan.partSizeBytes, file.sizeBytes);
      const chunk = file.bytes.slice(start, end);
      const response = await this._fetchFn(part.url, { method: 'PUT', body: bytesToBlob(chunk, file.mimeType) });
      if (!response.ok) throw new Error(`signed multipart PUT failed for part ${part.partNumber} (${response.status})`);
      const etag = response.headers.get('etag')?.replace(/^"|"$/g, '');
      if (!etag) throw new Error(`signed multipart PUT missing ETag for part ${part.partNumber}`);
      completedParts.push({ partNumber: part.partNumber, etag });
      uploaded += chunk.byteLength;
      onProgress?.(uploaded, file.sizeBytes);
    }
    return completedParts;
  }

  private async _uploadMultipart(
    file: NormalizedAssetUploadInput,
    options: IMAssetUploadOptions,
  ): Promise<IMResult<IMAsset>> {
    const { bytes, fileName, mimeType, sizeBytes, contentHash } = file;

    const formData = new FormData();
    formData.append('file', bytesToBlob(bytes, mimeType), fileName);
    formData.append('workspaceId', options.workspaceId);
    if (options.kind) formData.append('kind', options.kind);
    if (options.sourceAgentImUserId) formData.append('sourceAgentImUserId', options.sourceAgentImUserId);
    if (options.sourceTaskId) formData.append('sourceTaskId', options.sourceTaskId);
    if (options.metadata) formData.append('metadata', JSON.stringify(options.metadata));
    formData.append('contentSha256', contentHash);

    const resp = await this._fetchFn(`${this._baseUrl}/api/im/assets`, {
      method: 'POST',
      body: formData,
      headers: {
        ...this._getAuthHeaders(),
        'X-Content-Sha256': contentHash,
      },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        ok: false,
        error: data?.error || { code: 'http_error', message: `Upload failed (${resp.status})` },
      };
    }
    options.onProgress?.(sizeBytes, sizeBytes);
    return data as IMResult<IMAsset>;
  }
}

/**
 * Runtime installations (v1.9.3). Long-running daemon hosts inside a
 * workspace — distinct from short-lived per-task sandboxes. Built on
 * `IMContainer` rows with `taskId === null`.
 *
 * Endpoints live under `/api/workspace/runtime-installations` (Next.js App
 * Router), NOT under `/api/im/...`.
 */
export class RuntimeInstallationsClient {
  constructor(private _r: RequestFn) {}

  /**
   * List runtime installations in a workspace.
   *
   * v2.0.8 M448 (release201/20 §1) — `projectId` narrows scope:
   *   - omitted | `'all'`  → no project filter (legacy behaviour)
   *   - `'__unscoped'`     → only workspace-level rows (projectId IS NULL)
   *   - any other string   → exact projectId match
   */
  async list(
    workspaceId: string,
    options?: { limit?: number; projectId?: 'all' | '__unscoped' | string },
  ): Promise<IMResult<IMRuntimeInstallation[]>> {
    const query: Record<string, string> = { workspaceId };
    if (options?.limit != null) query.limit = String(options.limit);
    if (options?.projectId) query.projectId = options.projectId;
    return this._r('GET', '/api/workspace/runtime-installations', undefined, query);
  }

  /**
   * Create a new runtime installation. Mints a durable runtime API key,
   * RPCs the sandbox controller, and persists an `IMContainer` row.
   * The daemon receives `PRISMER_API_KEY`, `PRISMER_DAEMON_ID`,
   * `PRISMER_BASE_URL`, `PRISMER_WORKSPACE_ID`, and
   * `PRISMER_RUNTIME_KIND=workspace-daemon` env vars.
   *
   * v2.0.8 M448 — `options.projectId` (optional) opts into project scope.
   * Server validates it belongs to the same workspace and is `active`,
   * otherwise rejects 422 `PROJECT_WORKSPACE_MISMATCH` / `PROJECT_NOT_ACTIVE`.
   */
  async create(options: IMCreateRuntimeInstallationOptions): Promise<IMResult<IMRuntimeInstallation>> {
    return this._r('POST', '/api/workspace/runtime-installations', options);
  }

  /**
   * v2.0.8 M448 (release201/20 §1) — update the project binding on an
   * existing runtime installation. Pass `projectId: null` to detach.
   * No-op when body omits `projectId`. Same workspace/active invariant as
   * create — returns 422 on mismatch.
   */
  async patch(
    runtimeInstallationId: string,
    options: IMPatchRuntimeInstallationOptions,
  ): Promise<IMResult<IMRuntimeInstallation>> {
    return this._r(
      'PATCH',
      `/api/workspace/runtime-installations/${runtimeInstallationId}`,
      options,
    );
  }

  /**
   * Install an agent onto a runtime daemon. Resolves or creates the agent
   * profile, calls the controller's `installAgent` RPC, and stamps
   * `IMAgentCard.metadata.daemonId` + `runtimeInstallationId`.
   */
  async installAgent(
    runtimeInstallationId: string,
    options: IMInstallAgentOnRuntimeOptions,
  ): Promise<IMResult<IMInstallAgentOnRuntimeResult>> {
    return this._r('POST', `/api/workspace/runtime-installations/${runtimeInstallationId}/agents`, options);
  }
}

/** Map file extension to MIME type (no external deps) */
export function guessMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain', csv: 'text/csv', html: 'text/html', css: 'text/css',
    js: 'text/javascript', json: 'application/json', xml: 'application/xml',
    md: 'text/markdown', yaml: 'text/yaml', yml: 'text/yaml',
    zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
    mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
  };
  return map[ext] || 'application/octet-stream';
}

/** File upload management (presign → upload → confirm) */
export class FilesClient {
  constructor(
    private _r: RequestFn,
    private _baseUrl: string,
    private _fetchFn: typeof fetch,
    private _getAuthHeaders: () => Record<string, string>,
  ) {}

  /** Get a presigned upload URL */
  async presign(options: IMPresignOptions): Promise<IMResult<IMPresignResult>> {
    return this._r('POST', '/api/im/files/presign', options);
  }

  /** Confirm an uploaded file (triggers validation + CDN activation) */
  async confirm(uploadId: string): Promise<IMResult<IMConfirmResult>> {
    return this._r('POST', '/api/im/files/confirm', { uploadId });
  }

  /** Get storage quota */
  async quota(): Promise<IMResult<IMFileQuota>> {
    return this._r('GET', '/api/im/files/quota');
  }

  /** Delete a file */
  async delete(uploadId: string): Promise<IMResult<void>> {
    return this._r('DELETE', `/api/im/files/${uploadId}`);
  }

  /** List allowed MIME types */
  async types(): Promise<IMResult<{ allowedMimeTypes: string[] }>> {
    return this._r('GET', '/api/im/files/types');
  }

  /** Initialize a multipart upload (for files > 10 MB) */
  async initMultipart(opts: { fileName: string; fileSize: number; mimeType: string }): Promise<IMResult<IMMultipartInitResult>> {
    return this._r('POST', '/api/im/files/upload/init', opts);
  }

  /** Complete a multipart upload */
  async completeMultipart(uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<IMResult<IMConfirmResult>> {
    return this._r('POST', '/api/im/files/upload/complete', { uploadId, parts });
  }

  // --------------------------------------------------------------------------
  // High-level convenience methods
  // --------------------------------------------------------------------------

  /**
   * Upload a file (full lifecycle: presign → upload → confirm).
   *
   * @param input - File, Blob, Buffer, Uint8Array, or file path (Node.js string)
   * @param opts  - Optional fileName, mimeType, onProgress
   * @returns Confirmed upload result with CDN URL
   */
  async upload(input: FileInput, opts?: UploadOptions): Promise<UploadResult> {
    // 1. Resolve input → bytes + fileName + fileSize
    let bytes: Uint8Array;
    let fileName: string;

    if (typeof input === 'string') {
      // Node.js file path
      const { fs, path } = requireNodeBuiltins();
      const buf = await fs.promises.readFile(input);
      bytes = new Uint8Array(buf);
      fileName = opts?.fileName || path.basename(input);
    } else if (typeof Blob !== 'undefined' && input instanceof Blob) {
      // File extends Blob, so this covers both
      const ab = await input.arrayBuffer();
      bytes = new Uint8Array(ab);
      fileName = opts?.fileName || (input instanceof File ? input.name : '');
      if (!fileName) throw new Error('fileName is required when uploading Blob without name');
    } else if (input instanceof Uint8Array) {
      bytes = input;
      fileName = opts?.fileName || '';
      if (!fileName) throw new Error('fileName is required when uploading Buffer or Uint8Array');
    } else {
      throw new Error('Unsupported input type');
    }

    const fileSize = bytes.byteLength;

    // 2. Detect MIME
    const mimeType = opts?.mimeType || guessMimeType(fileName);

    // 3. Client-side size check
    if (fileSize > 50 * 1024 * 1024) {
      throw new Error('File exceeds maximum size of 50 MB');
    }

    // 4. Simple upload (≤ 10 MB) or multipart (> 10 MB)
    if (fileSize <= 10 * 1024 * 1024) {
      return this._uploadSimple(bytes, fileName, fileSize, mimeType, opts?.onProgress);
    }
    return this._uploadMultipart(bytes, fileName, fileSize, mimeType, opts?.onProgress);
  }

  /**
   * Upload a file and send it as a message in one call.
   *
   * @param conversationId - Target conversation
   * @param input          - File input (same as upload())
   * @param opts           - Upload options + optional message content/parentId
   */
  async sendFile(conversationId: string, input: FileInput, opts?: SendFileOptions): Promise<SendFileResult> {
    const uploaded = await this.upload(input, opts);

    // 2026-05-31 docs/release201/30 §6 — host-mode OUTBOX_DIR cp side-effect.
    // 模式抄自 sdk/cloud/mcp/src/tools/send-file.ts:163-199。当 daemon
    // 注入了 PRISMER_OUTBOX_DIR 时（dispatch.ts 经 adapters/prismer-env.ts
    // 注入），把源文件 cp 一份进去 → outbox-watcher.flushPending(taskId) 在
    // dispatch.reply 时自动把对应 assetId 挂到 reply.assetIds，真实化下游的
    // claim/asset 一致性（消除 lie-detector false-positive 的根因之一）。
    //
    // 非破坏性：env 未注入（CLI 在用户机器直接跑、daemon 不在 host-mode）→
    // 静默跳过；cloud 端 dual-write attachments[]（message.service.ts
    // populateFileMessageAttachments）兜底前端渲染。
    const outboxDir = process.env.PRISMER_OUTBOX_DIR;
    if (outboxDir) {
      try {
        const { fs: fsMod, path: pathMod } = requireNodeBuiltins();
        const srcPath = typeof input === 'string' ? input : (input as { path?: string }).path;
        if (srcPath && typeof srcPath === 'string') {
          await fsMod.promises.mkdir(outboxDir, { recursive: true });
          fsMod.cpSync(srcPath, pathMod.join(outboxDir, pathMod.basename(srcPath)));
        }
      } catch {
        // best-effort — 失败时 metadata.fileUrl 路径仍生效；cloud dual-write 兜底
      }
    }

    const msgRes: IMResult = await this._r('POST', `/api/im/messages/${conversationId}`, {
      content: opts?.content || uploaded.fileName,
      type: 'file',
      metadata: {
        uploadId: uploaded.uploadId,
        fileUrl: uploaded.cdnUrl,
        fileName: uploaded.fileName,
        fileSize: uploaded.fileSize,
        mimeType: uploaded.mimeType,
      },
      parentId: opts?.parentId,
    });

    if (!msgRes.ok) {
      throw new Error(msgRes.error?.message || 'Failed to send file message');
    }
    return { upload: uploaded, message: msgRes.data };
  }

  // --------------------------------------------------------------------------
  // Private upload helpers
  // --------------------------------------------------------------------------

  private async _uploadSimple(
    bytes: Uint8Array, fileName: string, fileSize: number, mimeType: string,
    onProgress?: (uploaded: number, total: number) => void,
  ): Promise<UploadResult> {
    // Presign
    const presignRes = await this.presign({ fileName, fileSize, mimeType });
    if (!presignRes.ok || !presignRes.data) {
      throw new Error(presignRes.error?.message || 'Presign failed');
    }
    const { uploadId, url, fields } = presignRes.data;

    // Build FormData
    const formData = new FormData();
    const isS3 = url.startsWith('http');
    const uploadUrl = isS3 ? url : `${this._baseUrl}${url}`;

    if (isS3) {
      for (const [k, v] of Object.entries(fields)) formData.append(k, v);
    }
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    formData.append('file', new Blob([ab], { type: mimeType }), fileName);

    // Upload
    const headers: Record<string, string> = {};
    if (!isS3) Object.assign(headers, this._getAuthHeaders());

    const resp = await this._fetchFn(uploadUrl, { method: 'POST', body: formData, headers });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Upload failed (${resp.status}): ${text}`);
    }

    onProgress?.(fileSize, fileSize);

    // Confirm
    const confirmRes = await this.confirm(uploadId);
    if (!confirmRes.ok || !confirmRes.data) {
      throw new Error(confirmRes.error?.message || 'Confirm failed');
    }
    return confirmRes.data;
  }

  private async _uploadMultipart(
    bytes: Uint8Array, fileName: string, fileSize: number, mimeType: string,
    onProgress?: (uploaded: number, total: number) => void,
  ): Promise<UploadResult> {
    // Init multipart
    const initRes = await this.initMultipart({ fileName, fileSize, mimeType });
    if (!initRes.ok || !initRes.data) {
      throw new Error(initRes.error?.message || 'Multipart init failed');
    }
    const { uploadId, parts: partUrls } = initRes.data;

    // Upload each part
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB
    const completedParts: Array<{ partNumber: number; etag: string }> = [];
    let uploaded = 0;

    for (const part of partUrls) {
      const start = (part.partNumber - 1) * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fileSize);
      const chunk = bytes.slice(start, end);

      const isS3 = part.url.startsWith('http');
      const partUrl = isS3 ? part.url : `${this._baseUrl}${part.url}`;
      const headers: Record<string, string> = { 'Content-Type': mimeType };
      if (!isS3) Object.assign(headers, this._getAuthHeaders());

      const resp = await this._fetchFn(partUrl, { method: 'PUT', body: chunk, headers });
      if (!resp.ok) {
        throw new Error(`Part ${part.partNumber} upload failed (${resp.status})`);
      }

      const etag = resp.headers.get('ETag') || `"part-${part.partNumber}"`;
      completedParts.push({ partNumber: part.partNumber, etag });

      uploaded += chunk.byteLength;
      onProgress?.(uploaded, fileSize);
    }

    // Complete
    const completeRes = await this.completeMultipart(uploadId, completedParts);
    if (!completeRes.ok || !completeRes.data) {
      throw new Error(completeRes.error?.message || 'Multipart complete failed');
    }
    return completeRes.data;
  }
}

/** Real-time connection factory (WebSocket & SSE) */
export class IMRealtimeClient {
  constructor(
    private _wsBase: string,
    private _fetchFn: typeof fetch = fetch.bind(globalThis),
  ) {}

  /** Get the WebSocket URL */
  wsUrl(token?: string): string {
    const base = this._wsBase.replace(/^http/, 'ws');
    return token ? `${base}/ws?token=${token}` : `${base}/ws`;
  }

  /** Get the SSE URL */
  sseUrl(token?: string): string {
    return token ? `${this._wsBase}/sse?token=${token}` : `${this._wsBase}/sse`;
  }

  /**
   * Get the URL for the v1.8.2 task SSE stream
   * (`GET /api/im/tasks/events?token=...`).
   * Supports `Last-Event-ID` for replay.
   */
  taskEventsUrl(token: string): string {
    return `${this._wsBase}/api/im/tasks/events?token=${encodeURIComponent(token)}`;
  }

  /** Create a WebSocket client. Call .connect() to establish connection. */
  connectWS(config: RealtimeConfig): RealtimeWSClient {
    return new RealtimeWSClient(this._wsBase, config);
  }

  /** Create an SSE client. Call .connect() to establish connection. */
  connectSSE(config: RealtimeConfig): RealtimeSSEClient {
    return new RealtimeSSEClient(this._wsBase, config);
  }

  /**
   * Subscribe to the task events SSE stream (v1.8.2/v1.9.3).
   *
   * Resolves with a `disconnect()` function for cleanup. Emits envelopes of
   * shape `{ id?, type, payload }` for each parsed `event:` block. Ignores
   * comment lines (`:` heartbeats).
   *
   * @example
   *   const sub = await client.im.realtime.subscribeTaskEvents(apiKey, (evt) => {
   *     if (evt.type === 'task.completed') console.log('done:', evt.payload);
   *   });
   *   // ... later:
   *   sub.disconnect();
   */
  async subscribeTaskEvents(
    token: string,
    onEvent: (event: TaskEventEnvelope) => void,
    options?: {
      lastEventId?: string;
      signal?: AbortSignal;
      /** release203/12 — prefer the unified single WS (`ch:'tasks'`) over the
       *  `/api/im/tasks/events` SSE. Default true; falls back to SSE when no
       *  WebSocket is available. */
      unifiedWs?: boolean;
      /** Custom WebSocket ctor (Node <21 / tests); else the global WebSocket. */
      WebSocket?: new (url: string) => WebSocket;
    },
  ): Promise<{ disconnect: () => void }> {
    // release203/12 — prefer the unified single WebSocket: consume the `tasks`
    // channel of `WS /ws/realtime` instead of the dedicated tasks SSE endpoint.
    const wantWs = options?.unifiedWs ?? true;
    const WS =
      options?.WebSocket ??
      (typeof WebSocket !== 'undefined' ? (WebSocket as new (url: string) => WebSocket) : undefined);
    if (wantWs && WS) {
      return this.subscribeTaskEventsWs(token, onEvent, WS, options?.signal);
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options?.signal?.addEventListener('abort', onAbort);

    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (options?.lastEventId) headers['Last-Event-ID'] = options.lastEventId;

    const resp = await this._fetchFn(this.taskEventsUrl(token), {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) {
      options?.signal?.removeEventListener('abort', onAbort);
      throw new Error(`Task events SSE failed: ${resp.status}`);
    }

    // Read stream in the background. Each SSE block is delimited by a
    // blank line; we accumulate `event:`, `id:`, `data:` then flush.
    void (async () => {
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let pending: { id?: string; type?: string; data: string[] } = { data: [] };
      const flush = () => {
        if (!pending.type && pending.data.length === 0) return;
        const dataStr = pending.data.join('\n');
        let payload: Record<string, unknown> = {};
        if (dataStr) {
          try { payload = JSON.parse(dataStr); } catch { /* leave as empty */ }
        }
        try {
          onEvent({
            id: pending.id,
            type: (pending.type ?? 'task.updated') as TaskEventType,
            payload,
          });
        } catch { /* user handler errors should not kill stream */ }
        pending = { data: [] };
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let lineEnd: number;
          // SSE messages end on \n\n; process line by line.
          while ((lineEnd = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
            buffer = buffer.slice(lineEnd + 1);
            if (line === '') {
              flush();
              continue;
            }
            if (line.startsWith(':')) continue; // comment
            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            const valueStr = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') pending.type = valueStr;
            else if (field === 'id') pending.id = valueStr;
            else if (field === 'data') pending.data.push(valueStr);
          }
        }
        flush();
      } catch { /* aborted or network error */ } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
        options?.signal?.removeEventListener('abort', onAbort);
      }
    })();

    return {
      disconnect: () => {
        try { controller.abort(); } catch { /* ignore */ }
      },
    };
  }

  /**
   * release203/12 — task events over the unified single WebSocket.
   * Connects to `WS /ws/realtime`, filters the `ch:'tasks'` frames, and emits
   * the SAME `{ type, payload }` envelopes `subscribeTaskEvents` did over SSE
   * (the WS carries no per-event `id`; cursor resume is handled by the sync
   * channel). The `ch:'sync'` frames + control frames are ignored here.
   */
  private subscribeTaskEventsWs(
    token: string,
    onEvent: (event: TaskEventEnvelope) => void,
    WS: new (url: string) => WebSocket,
    signal?: AbortSignal,
  ): { disconnect: () => void } {
    const wsBase = this._wsBase.replace(/^http/, 'ws').replace(/\/$/, '');
    const url = `${wsBase}/ws/realtime?token=${encodeURIComponent(token)}&since=0`;
    const ws = new WS(url);

    const disconnect = () => {
      try { ws.close(); } catch { /* ignore */ }
    };
    if (signal) {
      if (signal.aborted) disconnect();
      else signal.addEventListener('abort', disconnect, { once: true });
    }

    ws.onmessage = (ev: MessageEvent) => {
      let frame: { ch?: string; name?: string; data?: unknown };
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      // Only the tasks channel; control frames + the sync channel are ignored.
      if (frame.ch !== 'tasks' || !frame.name) return;
      try {
        onEvent({
          type: frame.name as TaskEventType,
          payload: (frame.data ?? {}) as Record<string, unknown>,
        });
      } catch { /* user handler errors should not kill the stream */ }
    };

    return { disconnect };
  }
}

// ============================================================================
// Skill Draft Client (release201/07 skill-authoring engine)
// ============================================================================

export interface SkillDraftManifestFile {
  path: string;
  /** UTF-8 text content (mutually exclusive with contentBase64). */
  content?: string;
  /** Base64 binary content (mutually exclusive with content). */
  contentBase64?: string;
}

export interface SkillDraftCreateInput {
  slug: string;
  name: string;
  description: string;
  workspaceId: string;
  ownerAgentId?: string;
  files: SkillDraftManifestFile[];
  metadata?: { authoring?: Record<string, unknown> };
}

export interface SkillDraftPatchOp {
  path: string;
  op: 'add' | 'update' | 'delete';
  content?: string;
  contentBase64?: string;
}

export interface SkillDraftPatchInput {
  files: SkillDraftPatchOp[];
  reason?: string;
}

export interface SkillDraftRegenerateInput {
  reason: string;
  newSources?: Array<{ kind: string; ref: string }>;
}

export interface SkillDraftValidationWarning {
  gate: string;
  message: string;
}

export interface SkillDraftCreateResult {
  id: string;
  slug: string;
  manifestRevision: string;
  reviewTaskId: string | null;
  validationWarnings: SkillDraftValidationWarning[];
}

export interface SkillDraftDTO {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: 'draft';
  workspaceId: string | null;
  ownerAgentId: string | null;
  manifestRevision: string | null;
  files: Array<{ path: string; size: number; sha256: string; inline: boolean; content?: string; url?: string }>;
  license: string | null;
  compatibility: string[];
  requires: Record<string, unknown>;
  executableJson: unknown;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Skill Draft client — release201/07 skill-authoring engine.
 *
 * Surface (mounted at `client.im.skills.draft`):
 *   create, patch, regenerate, show, list
 */
export class SkillsDraftClient {
  constructor(private _r: RequestFn) {}

  /** Create a draft skill from a manifest v1 payload. */
  async create(input: SkillDraftCreateInput): Promise<IMResult<SkillDraftCreateResult>> {
    return this._r('POST', '/api/im/skills/draft', input);
  }

  /** Apply incremental file ops to a draft. */
  async patch(id: string, input: SkillDraftPatchInput): Promise<IMResult<{ id: string; manifestRevision: string }>> {
    return this._r('PATCH', `/api/im/skills/${id}/draft`, input);
  }

  /** Request a regenerate session for a draft. */
  async regenerate(
    id: string,
    input: SkillDraftRegenerateInput,
  ): Promise<IMResult<{ id: string; sessionId: string; manifestRevision: string }>> {
    return this._r('POST', `/api/im/skills/${id}/draft/regenerate`, input);
  }

  /** Fetch a single draft's manifest + revision history. */
  async show(id: string): Promise<IMResult<SkillDraftDTO>> {
    return this._r('GET', `/api/im/skills/draft/${id}`);
  }

  /** List drafts for a workspace (most-recently-updated first). */
  async list(workspaceId: string): Promise<IMResult<SkillDraftDTO[]>> {
    return this._r('GET', '/api/im/skills/drafts', undefined, { workspaceId });
  }
}

/**
 * Top-level skills surface — draft authoring lives under `.draft`. Other
 * skill operations (search / install / etc.) remain on
 * `client.im.evolution.skills` for v2.0 compatibility.
 */
export class SkillsClient {
  readonly draft: SkillsDraftClient;

  constructor(_r: RequestFn) {
    this.draft = new SkillsDraftClient(_r);
  }
}

// ============================================================================
// PKF Client (canonical `/api/pkf/*`, deliberately outside the IM namespace)
// ============================================================================

export class PkfClient {
  constructor(
    private readonly _r: RequestFn,
    private readonly _fetchAuthed: (path: string, init?: RequestInit) => Promise<Response>,
  ) {}

  async materialize(
    input: PkfCarrierMaterializeRequest,
  ): Promise<PkfApiEnvelope<PkfCarrierMaterializationView>> {
    return this._r('POST', '/api/pkf/materializations', input);
  }

  async getMaterialization(
    query: PkfMaterializationReadQuery,
  ): Promise<PkfApiEnvelope<PkfCarrierMaterializationView | null>> {
    return this._r('GET', '/api/pkf/materializations', undefined, {
      workspaceId: query.workspaceId,
      idempotencyKey: query.idempotencyKey,
      targetKind: query.targetKind,
    });
  }

  async discoverMaterialization(
    query: PkfMaterializationDiscoveryQuery,
  ): Promise<PkfApiEnvelope<PkfCarrierMaterializationView | null>> {
    return this._r('GET', '/api/pkf/materializations', undefined, {
      workspaceId: query.workspaceId,
      messageId: query.source.messageId,
      blockId: query.source.blockId,
      blockRevision: String(query.source.blockRevision),
      sourceHash: query.source.sourceHash,
      targetKind: query.targetKind,
    });
  }

  /** Atomically commit a PKF root plus its exact root-bound dependency graph. */
  async commitBundle(input: PkfBundleCommitRequest): Promise<PkfApiEnvelope<PkfBundleCommitView>> {
    return this._r('POST', '/api/pkf/bundles/commit', input);
  }

  /** Restore the caller-scoped durable bundle receipt after process restart. */
  async getBundle(query: PkfBundleReadQuery): Promise<PkfApiEnvelope<PkfBundleCommitView>> {
    return this._r('GET', '/api/pkf/bundles/commit', undefined, {
      workspaceId: query.workspaceId,
      idempotencyKey: query.idempotencyKey,
    });
  }

  async getArtifactRelations(
    query: PkfArtifactRelationsQuery,
  ): Promise<PkfApiEnvelope<PkfArtifactGraphView>> {
    const rootKind = encodeURIComponent(query.rootKind);
    const rootId = encodeURIComponent(query.rootId);
    return this._r(
      'GET',
      `/api/pkf/artifacts/${rootKind}/${rootId}/relations`,
      undefined,
      { workspaceId: query.workspaceId, revision: String(query.revision) },
    );
  }

  async getResourceDetail(
    query: PkfResourceReadQuery,
  ): Promise<PkfApiEnvelope<PkfResourceDetailView>> {
    return this._r('GET', '/api/pkf/resources/detail', undefined, pkfResourceReadParams(query));
  }

  /**
   * Read root-authorized dependency bytes. This intentionally returns the raw
   * Response so callers can stream the body and verify `X-Asset-Hash`.
   */
  async getResourceBytes(query: PkfResourceReadQuery): Promise<Response> {
    const params = new URLSearchParams(pkfResourceReadParams(query));
    return this._fetchAuthed(`/api/pkf/resources/bytes?${params.toString()}`);
  }

  /** Low-level canonical request seam used by the Cloud CLI. */
  async request<T = unknown>(
    method: string,
    path: `/api/pkf/${string}`,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    return this._r<T>(method, path, body, query);
  }
}

function pkfResourceReadParams(query: PkfResourceReadQuery): Record<string, string> {
  const params: Record<string, string> = {
    workspaceId: query.workspaceId,
    rootKind: query.rootKind,
    rootId: query.rootId,
    rootRevision: String(query.rootRevision),
    rootHash: query.rootHash,
  };
  if (typeof query.targetAssetId === 'string') params.targetAssetId = query.targetAssetId;
  else if (typeof query.targetHash === 'string') params.targetHash = query.targetHash;
  else throw new TypeError('PKF resource read requires exactly one target locator');
  return params;
}

// ============================================================================
// IM Client (orchestrates sub-modules)
// ============================================================================

export class IMClient {
  readonly account: AccountClient;
  readonly direct: DirectClient;
  readonly groups: GroupsClient;
  readonly conversations: ConversationsClient;
  readonly messages: MessagesClient;
  readonly contacts: ContactsClient;
  readonly bindings: BindingsClient;
  readonly credits: CreditsClient;
  /** Legacy 1.7-era workspace bridge (`/workspace/init`, `/workspace/init-group`). */
  readonly workspace: WorkspaceClient;
  /** v1.9.3 first-class workspaces (`/api/im/workspaces`). */
  readonly workspaces: WorkspacesClient;
  /** v2.0.8 release201/16 Phase 9 — token-bearing invite endpoints (preview/accept/reject). */
  readonly invites: InvitesClient;
  /** v2.0.7 release201/09 project scope container (`/api/im/projects`). */
  readonly projects: ProjectsClient;
  /** v1.9.3 workspace files (`/api/im/workspaces/:id/files`). */
  readonly workspaceFiles: WorkspaceFilesClient;
  /** v1.9.3 content-addressed assets (`/api/im/assets`). */
  readonly assets: AssetsClient;
  /** v1.9.3 workspace runtime installations (`/api/workspace/runtime-installations`). */
  readonly runtimeInstallations: RuntimeInstallationsClient;
  readonly tasks: TasksClient;
  /** release201/10 acceptance template store. */
  readonly criteriaTemplates: CriteriaTemplatesClient;
  readonly memory: MemoryClient;
  readonly knowledge: KnowledgeLinkClient;
  /** v2.0.7 release201/11 — unified metric data channel. */
  readonly metrics: MetricsClient;
  readonly identity: IdentityClient;
  readonly security: SecurityClient;
  readonly agents: AgentsClient;
  readonly evolution: EvolutionClient;
  /** Top-level skill surface (release201/07 skill-authoring engine; `.draft.*` for drafts). */
  readonly skills: SkillsClient;
  /** Skill Studio BFF (release201/13). */
  readonly studio: StudioClient;
  readonly community: CommunityHub;
  readonly files: FilesClient;
  readonly realtime: IMRealtimeClient;
  /** Offline manager (null if offline mode not enabled) */
  readonly offline: OfflineManager | null;

  constructor(
    request: RequestFn,
    wsBase: string,
    fetchFn: typeof fetch,
    getAuthHeaders: () => Record<string, string>,
    offlineManager?: OfflineManager | null,
    communityHubConfig?: import('./types').CommunityHubConfig | null,
    authorityRequest: RequestFn = request,
  ) {
    this._request = request;
    this.account = new AccountClient(request);
    this.direct = new DirectClient(request);
    this.groups = new GroupsClient(request);
    this.conversations = new ConversationsClient(request);
    this.messages = new MessagesClient(request);
    this.contacts = new ContactsClient(request);
    this.bindings = new BindingsClient(request);
    this.credits = new CreditsClient(request);
    this.workspace = new WorkspaceClient(request);
    this.workspaces = new WorkspacesClient(request);
    this.invites = new InvitesClient(request);
    this.projects = new ProjectsClient(request, authorityRequest);
    this.workspaceFiles = new WorkspaceFilesClient(request);
    this.assets = new AssetsClient(request, wsBase, fetchFn, getAuthHeaders);
    this.runtimeInstallations = new RuntimeInstallationsClient(request);
    this.tasks = new TasksClient(request);
    this.criteriaTemplates = new CriteriaTemplatesClient(request);
    this.memory = new MemoryClient(request);
    this.knowledge = new KnowledgeLinkClient(request);
    this.metrics = new MetricsClient(request);
    this.identity = new IdentityClient(request);
    this.security = new SecurityClient(request);
    this.agents = new AgentsClient(request);
    this.evolution = new EvolutionClient(request);
    this.skills = new SkillsClient(request);
    this.studio = new StudioClient(request);
    this.community = new CommunityHub(request, communityHubConfig ?? undefined);
    this.files = new FilesClient(request, wsBase, fetchFn, getAuthHeaders);
    this.realtime = new IMRealtimeClient(wsBase, fetchFn);
    this.offline = offlineManager ?? null;
  }

  /** IM health check */
  async health(): Promise<IMResult<void>> {
    return this._request('GET', '/api/im/health');
  }

  /** Get workspace superset view with slot filtering */
  async getWorkspace(scope?: string, slots?: string[], includeContent?: boolean): Promise<any> {
    const params = new URLSearchParams();
    if (scope) params.set('scope', scope);
    if (slots?.length) params.set('slots', slots.join(','));
    if (includeContent) params.set('includeContent', 'true');
    return this._request('GET', `/api/im/workspace/view?${params}`);
  }

  /**
   * Issue a typed IM API request via the shared `RequestFn` pipeline.
   *
   * Use this when you need to hit an IM endpoint that isn't (yet) exposed by a
   * sub-client (e.g. `/api/im/approvals`). Same auth + offline routing + retry
   * behaviour as the typed sub-clients.
   *
   * @example
   *   const res = await client.im.request<ApprovalCreateResponse>(
   *     'POST', '/api/im/approvals', { category, title, context, options },
   *   );
   */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    return this._request<T>(method, path, body, query);
  }

  // Holds a reference to the RequestFn injected into all sub-clients.
  // Mirrors what each sub-client stores in `_r`, so `request()` reuses the
  // exact same auth + retry + offline-routing pipeline as typed calls.
  private readonly _request: RequestFn;
}

// ============================================================================
// Prismer Client
// ============================================================================

export class PrismerClient {
  private apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly fetchFn: typeof fetch;
  private readonly onRequestObservation?: PrismerConfig['onRequestObservation'];
  private readonly imAgent?: string;
  private readonly imWorkspace?: string;
  private _offlineManager: OfflineManager | null = null;
  /** AIP identity for auto-signing (v1.8.0 S1) */
  private _identity: AIPIdentity | null = null;
  private _identityReady: Promise<void> | null = null;

  /** IM API sub-client */
  readonly im: IMClient;
  /** Canonical Cloud PKF surface (`/api/pkf/*`), never nested under IM. */
  readonly pkf: PkfClient;
  /** v2.0 workspace public surface (`/api/im/workspaces`). */
  readonly workspaces: WorkspacesClient;
  /** v2.0.8 release201/16 — token-bearing invite endpoints (preview/accept/reject). */
  readonly invites: InvitesClient;
  /** v2.0.7 project scope public surface (`/api/im/projects`). */
  readonly projects: ProjectsClient;
  /** EaaS tenant environment surface (`/api/v1/environments/*`, eaas-gate-a Task 12). */
  readonly environments: EnvironmentsClient;
  readonly sandboxes: SandboxesClient;
  /** EaaS discovery surface (`/api/v1/context`). */
  readonly eaas: EaasClient;
  /** EaaS tenant-private skill catalog (`/api/v1/skills/*`, Gate B T8 — operator-only CRUD + publish). */
  readonly eaasSkills: EaasSkillsClient;
  readonly eaasMemories: EaasMemoriesClient;
  /** v2.0 workspace file public surface (`/api/im/workspaces/:id/files`). */
  readonly workspaceFiles: WorkspaceFilesClient;
  /** v2.0 workspace asset public surface (`/api/im/assets`). */
  readonly assets: AssetsClient;
  /** Backward-compatible evolution namespace; same instance as `client.im.evolution`. */
  readonly evolution: EvolutionClient;

  constructor(config: PrismerConfig = {}) {
    // Resolve API key: explicit → env → config.toml → ''
    const resolvedApiKey = resolveApiKey(config.apiKey);
    if (resolvedApiKey && !['sk-prismer-', 'eyJ', 'sk-eaas-', 'pk-eaas-', 'ps-eaas-'].some((prefix) => resolvedApiKey.startsWith(prefix))) {
      console.warn('Warning: unrecognized Prismer credential prefix');
    }

    this.apiKey = resolvedApiKey;
    const envUrl = ENVIRONMENTS[config.environment || 'production'];
    // Resolve base URL: explicit → env → config.toml → environment default
    this.baseUrl = (resolveBaseUrl(config.baseUrl) || envUrl).replace(/\/$/, '');
    this.timeout = config.timeout || 30000;
    // fetch 必须绑到 globalThis 再存字段：浏览器里解绑调用直接
    // "Illegal invocation"（UIKit eaas-sdk 真栈实测）；Node 绑定无副作用。
    this.fetchFn = config.fetch ?? fetch.bind(globalThis);
    this.onRequestObservation = config.onRequestObservation;
    this.imAgent = config.imAgent;
    this.imWorkspace = config.imWorkspace;

    // v1.8.0 S1: Initialize AIP identity for auto-signing
    if (config.identity) {
      if (config.identity === 'auto' && this.apiKey) {
        this._identityReady = AIPIdentity.fromApiKey(this.apiKey)
          // Keep the public Cloud DTS build independent of whichever resolver
          // provides @prismer/aip-sdk (local staging or a published package).
          // Some resolvers expose the factory return as `any`, so inference
          // alone would leak implicit-any callback parameters into declaration
          // generation.
          .then((id: AIPIdentity) => { this._identity = id; })
          .catch((err: unknown) => console.warn('[PrismerSDK] Identity init failed:', err));
      } else if (typeof config.identity === 'object' && config.identity.privateKey) {
        const keyBytes = typeof Buffer !== 'undefined'
          ? new Uint8Array(Buffer.from(config.identity.privateKey, 'base64'))
          : new Uint8Array(atob(config.identity.privateKey).split('').map(c => c.charCodeAt(0)));
        this._identityReady = AIPIdentity.fromPrivateKey(keyBytes)
          .then((id: AIPIdentity) => { this._identity = id; })
          .catch((err: unknown) => console.warn('[PrismerSDK] Identity init failed:', err));
      }
    }

    // Initialize OfflineManager if offline config is provided
    if (config.offline) {
      this._offlineManager = new OfflineManager(
        config.offline.storage,
        // OfflineManager has a 4-arg RequestFn signature (legacy); the 5th
        // opts param is dropped on the offline path until OfflineManager is
        // upgraded. Online path forwards opts (see below).
        (m, p, b, q) => this._request(m, p, b, q),
        config.offline,
      );
      this._offlineManager.init().catch(err =>
        console.warn('[PrismerSDK] Offline storage init failed:', err)
      );
    }

    // IM requests go through OfflineManager when offline mode is enabled
    let imRequest: RequestFn = this._offlineManager
      ? <T>(m: string, p: string, b?: unknown, q?: Record<string, string>, _opts?: RequestOpts) =>
          // Offline path: opts dropped (manager doesn't forward headers yet).
          // Idempotency key is also stamped into the body JSON, so server-side
          // dedup still works via the JSON field even without the header.
          this._offlineManager!.dispatch<T>(m, p, b, q)
      : <T>(m: string, p: string, b?: unknown, q?: Record<string, string>, opts?: RequestOpts) =>
          this._request<T>(m, p, b, q, opts);

    // v1.8.0 S1: Wrap with auto-signing for IM message sends
    if (config.identity) {
      const baseRequest = imRequest;
      imRequest = <T>(method: string, path: string, body?: unknown, query?: Record<string, string>, opts?: RequestOpts): Promise<T> => {
        // Only sign POST requests to message endpoints
        if (method === 'POST' && path.includes('/messages') && body) {
          const b = body as Record<string, any>;
          if (!b.signature && !b.skipSigning) {
            // Await identity initialization before signing to avoid race condition
            const ready = this._identityReady || Promise.resolve();
            return ready.then(() => {
              if (this._identity) {
                return this._signAndSend<T>(baseRequest, method, path, b, query, opts);
              }
              return baseRequest<T>(method, path, body, query, opts);
            });
          }
        }
        return baseRequest<T>(method, path, body, query, opts);
      };
    }

    this.im = new IMClient(
      imRequest,
      this.baseUrl,
      this.fetchFn,
      () => this._getAuthHeaders(),
      this._offlineManager,
      config.community ?? null,
      // EaaS authority calls must not enter the IM offline outbox or lose CAS headers.
      (m, p, b, q, opts) => this._request(m, p, b, q, opts),
    );
    // PKF authority is Cloud-owned and must not enter the legacy IM offline
    // dispatcher merely because its target carrier can be an Asset or Page.
    this.pkf = new PkfClient(
      (method, path, body, query, opts) => this._request(method, path, body, query, opts),
      (path, init) => this.fetchAuthed(path, init),
    );
    this.workspaces = this.im.workspaces;
    this.invites = this.im.invites;
    this.projects = this.im.projects;
    this.workspaceFiles = this.im.workspaceFiles;
    this.assets = this.im.assets;
    this.evolution = this.im.evolution;
    // EaaS surface — same dual-injection shape as PKF: shared `_request`
    // pipeline for JSON envelopes + raw `fetchAuthed` seam for the binary
    // file face. Note the EaaS API key (`sk-eaas-…`) rides the same
    // Authorization Bearer header.
    this.environments = new EnvironmentsClient(
      (method, path, body, query, opts) => this._request(method, path, body, query, opts),
      (path, init) => this.fetchAuthed(path, init),
    );
    this.sandboxes = new SandboxesClient(this.environments);
    this.eaas = new EaasClient((method, path, body, query, opts) =>
      this._request(method, path, body, query, opts),
    );
    // Tenant-scoped JSON face（无 env/project 段）——同一 `_request` 管线。
    this.eaasSkills = new EaasSkillsClient(
      (method, path, body, query, opts) => this._request(method, path, body, query, opts),
    );
    this.eaasMemories = new EaasMemoriesClient(
      (method, path, body, query, opts) => this._request(method, path, body, query, opts),
    );
  }

  /** Wait for identity to be ready (useful for tests or explicit await) */
  async ensureIdentity(): Promise<AIPIdentity | null> {
    if (this._identityReady) await this._identityReady;
    return this._identity;
  }

  /** Auto-sign a message body and send (v1.8.0 S1) */
  private async _signAndSend<T>(
    baseRequest: RequestFn,
    method: string,
    path: string,
    body: Record<string, any>,
    query?: Record<string, string>,
    opts?: RequestOpts,
  ): Promise<T> {
    if (this._identityReady) await this._identityReady;
    if (!this._identity) return baseRequest<T>(method, path, body, query, opts);

    const content = body.content || '';
    const contentHashBytes = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)),
    );
    const contentHash = Array.from(contentHashBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    // Build lite signing payload (v1.8.0: secVersion|senderDid|type|timestamp|contentHash)
    const timestamp = Date.now();
    const payload = `1|${this._identity.did}|${body.type || 'text'}|${timestamp}|${contentHash}`;
    const payloadBytes = new TextEncoder().encode(payload);
    const signature = await this._identity.sign(payloadBytes);

    return baseRequest<T>(method, path, {
      ...body,
      secVersion: 1,
      senderDid: this._identity.did,
      contentHash,
      signature,
      signedAt: timestamp,
    }, query, opts);
  }

  /** Build auth headers for raw HTTP requests (used by file upload) */
  private _getAuthHeaders(authority: 'im' | 'pkf' = 'im'): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    if (this.imAgent) {
      headers[authority === 'pkf' ? 'X-Prismer-Agent' : 'X-IM-Agent'] = this.imAgent;
    }
    if (this.imWorkspace) headers['X-IM-Workspace'] = this.imWorkspace;
    return headers;
  }

  /**
   * Set or update the auth token (API key or IM JWT).
   * Useful after anonymous registration to set the returned JWT.
   */
  setToken(token: string): void {
    this.apiKey = token;
  }

  /** Cleanup resources (offline manager, timers). Call when disposing the client. */
  async destroy(): Promise<void> {
    if (this._offlineManager) {
      await this._offlineManager.destroy();
    }
  }

  /**
   * Issue an authenticated raw HTTP request against the configured base URL,
   * returning the underlying `Response` so callers can inspect headers
   * (`Content-Range`, `Content-Length`, etc.) and stream the body.
   *
   * The path may be absolute (`/api/...`) or a full URL — full URLs are used
   * verbatim (useful for following 302 redirects), otherwise the path is
   * appended to the client's configured `baseUrl`. Authorization plus the
   * authority-specific agent header are added automatically: canonical PKF
   * requests use `X-Prismer-Agent`, while legacy `/api/im/*` keeps
   * `X-IM-Agent`. Caller-supplied headers override them on collision.
   *
   * Use this for binary downloads / partial fetches; for normal JSON-envelope
   * IM requests use `client.im.request()` (typed) or the typed sub-clients.
   */
  async fetchAuthed(url: string, init?: RequestInit): Promise<Response> {
    const fullUrl = /^https?:\/\//i.test(url) ? url : `${this.baseUrl}${url}`;
    const authHeaders = this._getAuthHeaders(/\/api\/pkf\//.test(url) ? 'pkf' : 'im');
    const callerHeaders: Record<string, string> = {};
    if (init?.headers) {
      // Normalise Headers / Record / array shapes into a plain Record so we can
      // merge with caller-precedence semantics.
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => { callerHeaders[k] = v; });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) callerHeaders[k] = v;
      } else {
        Object.assign(callerHeaders, h as Record<string, string>);
      }
    }
    const headers: Record<string, string> = { ...authHeaders, ...callerHeaders };
    return this.fetchFn(fullUrl, { ...(init ?? {}), headers });
  }

  // --------------------------------------------------------------------------
  // Internal request helper
  // --------------------------------------------------------------------------

  private async _request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    opts?: RequestOpts,
    _isRetry?: boolean,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const observation: import('./types').RequestObservation = {
      method, path: path.split('?')[0], retry: _isRetry === true, status: null, requestId: null, contentType: null,
      headersMs: null, durationMs: 0, outcome: 'transport_error',
    };
    const started = performance.now();
    let attemptFinished: number | undefined;

    try {
      let url = `${this.baseUrl}${path}`;
      if (query && Object.keys(query).length > 0) {
        url += '?' + new URLSearchParams(query).toString();
      }

      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }
      if (this.imAgent) {
        headers[path.startsWith('/api/pkf/') ? 'X-Prismer-Agent' : 'X-IM-Agent'] = this.imAgent;
      }
      // release202/09 §3.6 B — optional workspace hint so the cloud agent-proxy
      // can reach its workspace-scoped fallback. Same opt-in shape as X-IM-Agent.
      if (this.imWorkspace) {
        headers['X-IM-Workspace'] = this.imWorkspace;
      }
      // v2.0: per-call extra headers (e.g. X-Idempotency-Key for message sends).
      // Caller wins over default Authorization/agent/workspace headers on collision.
      if (opts?.headers) {
        for (const [k, v] of Object.entries(opts.headers)) headers[k] = v;
      }

      const init: RequestInit = { method, headers, signal: controller.signal };

      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }

      const response = await this.fetchFn(url, init);
      observation.headersMs = performance.now() - started;
      observation.status = response.status;
      observation.requestId = response.headers.get('x-request-id');
      observation.contentType = response.headers.get('content-type');
      observation.outcome = 'decode_error';
      const data = await response.json();
      attemptFinished = performance.now();
      observation.requestId = typeof data?.requestId === 'string' ? data.requestId : observation.requestId;
      observation.outcome = response.ok ? 'success' : 'http_error';

      // h-contact-system-refactor §9-SDK — 202 ACTION_DEFERRED 契约（跨台联系人
      // 审批等）：提升 deferred/approvalId 到 result 顶层，调用方（offline ack /
      // CLI 分支）才能区分「已发送」与「等待审批」——否则 202 会被当成功
      // ack 掉 outbox op，审批通过后重发的义务永久丢失。
      if (response.status === 202 && data && typeof data === 'object' && data.data?.deferred === true) {
        data.deferred = true;
        data.approvalId = data.data?.approvalId ?? null;
      }

      // Auto-refresh JWT token on 401 (one attempt, skip if already retrying)
      if (response.status === 401 && this.apiKey.startsWith('eyJ') && !_isRetry && !path.includes('/token/refresh')) {
        try {
          const refreshRes = await this._request<any>('POST', '/api/im/token/refresh', undefined, undefined, undefined, true);
          if (refreshRes?.ok && refreshRes?.data?.token) {
            this.apiKey = refreshRes.data.token;
            // Replay original request — re-use same idempotency key in opts so
            // any send retried after a token refresh hits server-side dedup.
            return this._request<T>(method, path, body, query, opts, true);
          }
        } catch { /* refresh failed, return original error */ }
      }

      if (!response.ok) {
        // v2.0 BREAKING: error.code is now lower_snake to align with runtime +
        // cloud conventions (`auth_invalid`, `cloud_unreachable`, ...). See
        // CHANGELOG for the migration table.
        const err = data.error || { code: 'http_error', message: `Request failed with status ${response.status}` };
        const failure = { ...data, success: false, ok: false, error: err };
        if (path.startsWith('/api/v1/')) rememberRetryAfter(failure, response);
        return failure as T;
      }

      return data as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        observation.outcome = 'timeout';
        return { success: false, ok: false, error: { code: 'timeout', message: 'Request timed out' } } as T;
      }
      return {
        success: false,
        ok: false,
        error: { code: 'cloud_unreachable', message: error instanceof Error ? error.message : 'Unknown error' },
      } as T;
    } finally {
      clearTimeout(timeoutId);
      observation.durationMs = (attemptFinished ?? performance.now()) - started;
      try { void Promise.resolve(this.onRequestObservation?.(observation)).catch(() => undefined); } catch { /* Observability must not change request results. */ }
    }
  }

  // --------------------------------------------------------------------------
  // Context API
  // --------------------------------------------------------------------------

  /** Load content from URL(s) or search query */
  async load(input: string | string[], options: LoadOptions = {}): Promise<LoadResult> {
    return this._request('POST', '/api/context/load', {
      input,
      inputType: options.inputType,
      processUncached: options.processUncached,
      search: options.search,
      processing: options.processing,
      return: options.return,
      ranking: options.ranking,
    });
  }

  /** Save content to Prismer cache */
  async save(options: SaveOptions | SaveBatchOptions): Promise<SaveResult> {
    return this._request('POST', '/api/context/save', options);
  }

  /** Batch save multiple items (max 50) */
  async saveBatch(items: SaveOptions[]): Promise<SaveResult> {
    return this.save({ items });
  }

  // --------------------------------------------------------------------------
  // Parse API
  // --------------------------------------------------------------------------

  /** Parse a document (PDF, image) into structured content */
  async parse(options: ParseOptions): Promise<ParseResult> {
    return this._request('POST', '/api/parse', options);
  }

  /** Convenience: parse a PDF by URL */
  async parsePdf(url: string, mode: 'fast' | 'hires' | 'auto' = 'fast'): Promise<ParseResult> {
    return this.parse({ url, mode });
  }

  /** Check status of an async parse task */
  async parseStatus(taskId: string): Promise<ParseResult> {
    return this._request('GET', `/api/parse/status/${taskId}`);
  }

  /** Get result of a completed async parse task */
  async parseResult(taskId: string): Promise<ParseResult> {
    return this._request('GET', `/api/parse/result/${taskId}`);
  }

  // --------------------------------------------------------------------------
  // Models API (LLM proxy model listing)
  // --------------------------------------------------------------------------

  /** List LLM models exposed by the cloud LLM proxy (OpenAI format). */
  async listModels(): Promise<ModelEntry[]> {
    const res = await this._request<{ object: string; data: ModelEntry[] }>('GET', '/api/v1/models');
    return res.data ?? [];
  }

  // --------------------------------------------------------------------------
  // Convenience
  // --------------------------------------------------------------------------

  /** Search for content (convenience wrapper around load with query mode) */
  async search(
    query: string,
    options?: { topK?: number; returnTopK?: number; format?: 'hqcc' | 'raw' | 'both'; ranking?: 'cache_first' | 'relevance_first' | 'balanced' },
  ): Promise<LoadResult> {
    return this.load(query, {
      inputType: 'query',
      search: options?.topK ? { topK: options.topK } : undefined,
      return: (options?.returnTopK || options?.format)
        ? { topK: options?.returnTopK, format: options?.format }
        : undefined,
      ranking: options?.ranking ? { preset: options.ranking } : undefined,
    });
  }
}

export default PrismerClient;

export function createClient(config: PrismerConfig): PrismerClient {
  return new PrismerClient(config);
}

export type {
  LLMDispatcher, LLMBackend, LLMTask, LLMResult,
  NotificationSink, PrismerEvent,
  TaskExecutor, ExecutionPolicy, QueuedTask,
  CacheManager,
  KeyManager,
  DaemonControlPlane, ControlCommand, CommandResult,
} from './daemon-interfaces';
