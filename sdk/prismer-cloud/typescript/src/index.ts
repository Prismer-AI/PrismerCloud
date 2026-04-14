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
import { CommunityHub } from './community-hub';
import { AIPIdentity } from './aip';

// Node.js built-ins — optional (not available in browser environments)
let _fs: typeof import('fs') | null = null;
let _os: typeof import('os') | null = null;
let _path: typeof import('path') | null = null;
try {
  _fs = require('fs');
  _os = require('os');
  _path = require('path');
} catch {
  // Browser environment — config.toml fallback not available
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
  IMFriendRequest,
  IMBlockedUser,
  IMUserProfile,
  IMDiscoverOptions,
  IMDiscoverAgent,
  IMCreateBindingOptions,
  IMBindingData,
  IMBinding,
  IMCreditsData,
  IMTransaction,
  IMWorkspaceData,
  IMWorkspaceInitOptions,
  IMWorkspaceInitGroupOptions,
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
  // Tasks
  IMCreateTaskOptions,
  IMUpdateTaskOptions,
  IMTaskListOptions,
  IMCompleteTaskOptions,
  IMTask,
  IMTaskDetail,
  // Memory
  IMCreateMemoryFileOptions,
  IMUpdateMemoryFileOptions,
  IMCompactOptions,
  IMMemoryFile,
  IMMemoryFileDetail,
  IMCompactionSummary,
  IMMemoryLoadResult,
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
  IMSkillInstallResult,
  IMAgentSkillRecord,
  IMSkillContent,
} from './types';

import { ENVIRONMENTS } from './types';

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
}

/** Direct messaging between two users */
export class DirectClient {
  constructor(private _r: RequestFn) {}

  /** Send a direct message to a user */
  async send(userId: string, content: string, options?: IMSendOptions): Promise<IMResult<IMMessageData>> {
    return this._r('POST', `/api/im/direct/${userId}/messages`, {
      content,
      type: options?.type ?? 'text',
      metadata: options?.metadata,
      parentId: options?.parentId,
      quotedMessageId: options?.quotedMessageId,
    });
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

  /** Send a message to a group */
  async send(groupId: string, content: string, options?: IMSendOptions): Promise<IMResult<IMMessageData>> {
    return this._r('POST', `/api/im/groups/${groupId}/messages`, {
      content,
      type: options?.type ?? 'text',
      metadata: options?.metadata,
      parentId: options?.parentId,
      quotedMessageId: options?.quotedMessageId,
    });
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

  /** Send a message to a conversation */
  async send(conversationId: string, content: string, options?: IMSendOptions): Promise<IMResult<IMMessageData>> {
    return this._r('POST', `/api/im/messages/${conversationId}`, {
      content,
      type: options?.type ?? 'text',
      metadata: options?.metadata,
      parentId: options?.parentId,
      quotedMessageId: options?.quotedMessageId,
    });
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

  /** Add an agent to a workspace */
  async addAgent(workspaceId: string, agentId: string): Promise<IMResult<void>> {
    return this._r('POST', `/api/im/workspace/${workspaceId}/agents`, { agentId });
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
    if (options?.status) query.status = options.status;
    if (options?.capability) query.capability = options.capability;
    if (options?.assigneeId) query.assigneeId = options.assigneeId;
    if (options?.creatorId) query.creatorId = options.creatorId;
    if (options?.scheduleType) query.scheduleType = options.scheduleType;
    if (options?.limit != null) query.limit = String(options.limit);
    if (options?.cursor) query.cursor = options.cursor;
    return this._r('GET', '/api/im/tasks', undefined, query);
  }

  /** Get task details with logs */
  async get(taskId: string): Promise<IMResult<IMTaskDetail>> {
    return this._r('GET', `/api/im/tasks/${taskId}`);
  }

  /** Update a task */
  async update(taskId: string, options: IMUpdateTaskOptions): Promise<IMResult<IMTask>> {
    return this._r('PATCH', `/api/im/tasks/${taskId}`, options);
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

  /** Reject a task with reason */
  async reject(taskId: string, reason: string): Promise<IMResult<IMTask>> {
    return this._r('POST', `/api/im/tasks/${taskId}/reject`, { reason });
  }

  /** Cancel a task */
  async cancel(taskId: string): Promise<IMResult<IMTask>> {
    return this._r('DELETE', `/api/im/tasks/${taskId}`);
  }
}

/** Memory management: files, compaction, session load */
export class MemoryClient {
  constructor(private _r: RequestFn) {}

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

/** Skill Evolution: gene management, analysis, recording, distillation */
export class EvolutionClient {
  constructor(private _r: RequestFn) {}

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
      return { ok: false, error: analysis.error } as any;
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
  async searchSkills(options?: { query?: string; category?: string; limit?: number }): Promise<IMResult<any[]>> {
    const q: Record<string, string> = {};
    if (options?.query) q.query = options.query;
    if (options?.category) q.category = options.category;
    if (options?.limit != null) q.limit = String(options.limit);
    return this._r('GET', '/api/im/skills/search', undefined, q);
  }

  /** Get skill catalog stats */
  async getSkillStats(): Promise<IMResult<any>> {
    return this._r('GET', '/api/im/skills/stats');
  }

  /** Install a skill — creates Gene + returns content + install guide */
  async installSkill(slugOrId: string, scope?: string): Promise<IMResult<IMSkillInstallResult>> {
    return this._r('POST', `/api/im/skills/${encodeURIComponent(slugOrId)}/install`, scope ? { scope } : undefined);
  }

  /** Uninstall a skill */
  async uninstallSkill(slugOrId: string): Promise<IMResult<{ uninstalled: boolean }>> {
    return this._r('DELETE', `/api/im/skills/${encodeURIComponent(slugOrId)}/install`);
  }

  /** List installed skills for this agent */
  async installedSkills(): Promise<IMResult<IMAgentSkillRecord[]>> {
    return this._r('GET', '/api/im/skills/installed');
  }

  /** Get full skill content (SKILL.md + package info) */
  async getSkillContent(slugOrId: string): Promise<IMResult<IMSkillContent>> {
    return this._r('GET', `/api/im/skills/${encodeURIComponent(slugOrId)}/content`);
  }

  /** Create/submit a community skill */
  async createSkill(input: {
    name: string;
    description: string;
    category: string;
    tags?: string[];
    content?: string;
    signals?: Array<{ type: string }>;
    author?: string;
  }): Promise<IMResult<any>> {
    return this._r('POST', '/api/im/skills', input);
  }

  /** Star a skill (increment community rating) */
  async starSkill(skillId: string): Promise<IMResult<{ stars: number }>> {
    return this._r('POST', `/api/im/skills/${encodeURIComponent(skillId)}/star`);
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
    if (!result.ok || !result.data) return result as any;

    // 2. Get content
    let content = (result.data.skill as any)?.content || '';
    if (!content) {
      const contentResult = await this.getSkillContent(slugOrId);
      content = contentResult.data?.content || '';
    }
    if (!content) {
      return { ...result, data: { ...result.data, localPaths: [] } } as any;
    }

    // 3. Determine slug (sanitize to prevent path traversal)
    const rawSlug = (result.data.skill as any)?.slug || slugOrId;
    const slug = rawSlug.replace(/[\/\\]/g, '').replace(/\.\./g, '');
    if (!slug) {
      return { ...result, data: { ...result.data, localPaths: [] } } as any;
    }

    // 4. Write to local paths
    const localPaths: string[] = [];
    // Need dynamic import for Node.js APIs (SDK may run in browser too)
    try {
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');
      const home = os.homedir();

      const pluginBase = process.env.PRISMER_PLUGIN_DIR || path.join(home, '.claude', 'plugins', 'prismer');
      const platformPaths: Record<string, string> = options?.project
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

      const targets = options?.platforms || (Object.keys(platformPaths) as Array<'claude-code' | 'openclaw' | 'opencode' | 'plugin'>);

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

    return { ...result, data: { ...result.data, localPaths } } as any;
  }

  /**
   * Uninstall a skill and remove local SKILL.md files.
   */
  async uninstallSkillLocal(slugOrId: string): Promise<IMResult<{ uninstalled: boolean; removedPaths: string[] }>> {
    const result = await this.uninstallSkill(slugOrId);
    const removedPaths: string[] = [];

    // Sanitize slug to prevent path traversal
    const slug = safeSlug(slugOrId);
    if (!slug) return { ...result, data: { uninstalled: result.data?.uninstalled ?? false, removedPaths } } as any;

    try {
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');
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

    return { ...result, data: { uninstalled: result.data?.uninstalled ?? false, removedPaths } } as any;
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

    for (const record of installed.data) {
      const rawSlug = (record.skill as any)?.slug;
      if (!rawSlug) { failed++; continue; }
      const slug = rawSlug.replace(/[\/\\]/g, '').replace(/\.\./g, '');
      if (!slug) { failed++; continue; }

      try {
        const contentResult = await this.getSkillContent(slug);
        const content = contentResult.data?.content;
        if (!content) { failed++; continue; }

        const fs = await import('fs');
        const path = await import('path');
        const os = await import('os');
        const home = os.homedir();

        const pluginBase = process.env.PRISMER_PLUGIN_DIR || path.join(home, '.claude', 'plugins', 'prismer');
        const platformPaths: Record<string, string> = {
          'claude-code': path.join(home, '.claude', 'skills', slug),
          'openclaw': path.join(home, '.openclaw', 'skills', slug),
          'opencode': path.join(home, '.config', 'opencode', 'skills', slug),
          'plugin': path.join(pluginBase, 'skills', slug),
        };

        const targets = options?.platforms || (Object.keys(platformPaths) as any[]);
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

  /** Bidirectional sync: push local outcomes and pull remote updates */
  async sync(options?: { pushOutcomes?: any[]; pullSince?: number }): Promise<IMResult<any>> {
    const body: Record<string, any> = {};
    if (options?.pushOutcomes) body.push = { outcomes: options.pushOutcomes };
    if (options?.pullSince != null) body.pull = { since: options.pullSince };
    return this._r('POST', '/api/im/evolution/sync', body);
  }
}

/** Re-export v1.8.0 community module (cache + intents + REST). */
export { CommunityHub } from './community-hub';
export type { CommunityHubConfig } from './types';

/** Sanitize a slug/id to prevent path traversal (removes slashes, .., and null bytes) */
export function safeSlug(input: string): string {
  return input.replace(/[\/\\]/g, '').replace(/\.\./g, '').replace(/\0/g, '');
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
      const fs = await import('fs');
      const path = await import('path');
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
  constructor(private _wsBase: string) {}

  /** Get the WebSocket URL */
  wsUrl(token?: string): string {
    const base = this._wsBase.replace(/^http/, 'ws');
    return token ? `${base}/ws?token=${token}` : `${base}/ws`;
  }

  /** Get the SSE URL */
  sseUrl(token?: string): string {
    return token ? `${this._wsBase}/sse?token=${token}` : `${this._wsBase}/sse`;
  }

  /** Create a WebSocket client. Call .connect() to establish connection. */
  connectWS(config: RealtimeConfig): RealtimeWSClient {
    return new RealtimeWSClient(this._wsBase, config);
  }

  /** Create an SSE client. Call .connect() to establish connection. */
  connectSSE(config: RealtimeConfig): RealtimeSSEClient {
    return new RealtimeSSEClient(this._wsBase, config);
  }
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
  readonly workspace: WorkspaceClient;
  readonly tasks: TasksClient;
  readonly memory: MemoryClient;
  readonly knowledge: KnowledgeLinkClient;
  readonly identity: IdentityClient;
  readonly security: SecurityClient;
  readonly evolution: EvolutionClient;
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
  ) {
    this.account = new AccountClient(request);
    this.direct = new DirectClient(request);
    this.groups = new GroupsClient(request);
    this.conversations = new ConversationsClient(request);
    this.messages = new MessagesClient(request);
    this.contacts = new ContactsClient(request);
    this.bindings = new BindingsClient(request);
    this.credits = new CreditsClient(request);
    this.workspace = new WorkspaceClient(request);
    this.tasks = new TasksClient(request);
    this.memory = new MemoryClient(request);
    this.knowledge = new KnowledgeLinkClient(request);
    this.identity = new IdentityClient(request);
    this.security = new SecurityClient(request);
    this.evolution = new EvolutionClient(request);
    this.community = new CommunityHub(request, communityHubConfig ?? undefined);
    this.files = new FilesClient(request, wsBase, fetchFn, getAuthHeaders);
    this.realtime = new IMRealtimeClient(wsBase);
    this.offline = offlineManager ?? null;
  }

  /** IM health check */
  async health(): Promise<IMResult<void>> {
    return this.account['_r']('GET', '/api/im/health');
  }

  /** Get workspace superset view with slot filtering */
  async getWorkspace(scope?: string, slots?: string[], includeContent?: boolean): Promise<any> {
    const params = new URLSearchParams();
    if (scope) params.set('scope', scope);
    if (slots?.length) params.set('slots', slots.join(','));
    if (includeContent) params.set('includeContent', 'true');
    return this.workspace['_r']('GET', `/api/im/workspace/view?${params}`);
  }
}

// ============================================================================
// Prismer Client
// ============================================================================

export class PrismerClient {
  private apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly fetchFn: typeof fetch;
  private readonly imAgent?: string;
  private _offlineManager: OfflineManager | null = null;
  /** AIP identity for auto-signing (v1.8.0 S1) */
  private _identity: AIPIdentity | null = null;
  private _identityReady: Promise<void> | null = null;

  /** IM API sub-client */
  readonly im: IMClient;

  constructor(config: PrismerConfig = {}) {
    // Resolve API key: explicit → env → config.toml → ''
    const resolvedApiKey = resolveApiKey(config.apiKey);
    if (resolvedApiKey && !resolvedApiKey.startsWith('sk-prismer-') && !resolvedApiKey.startsWith('eyJ')) {
      console.warn('Warning: API key should start with "sk-prismer-" (or "eyJ" for IM JWT)');
    }

    this.apiKey = resolvedApiKey;
    const envUrl = ENVIRONMENTS[config.environment || 'production'];
    // Resolve base URL: explicit → env → config.toml → environment default
    this.baseUrl = (resolveBaseUrl(config.baseUrl) || envUrl).replace(/\/$/, '');
    this.timeout = config.timeout || 30000;
    this.fetchFn = config.fetch || fetch;
    this.imAgent = config.imAgent;

    // v1.8.0 S1: Initialize AIP identity for auto-signing
    if (config.identity) {
      if (config.identity === 'auto' && this.apiKey) {
        this._identityReady = AIPIdentity.fromApiKey(this.apiKey)
          .then(id => { this._identity = id; })
          .catch(err => console.warn('[PrismerSDK] Identity init failed:', err));
      } else if (typeof config.identity === 'object' && config.identity.privateKey) {
        const keyBytes = typeof Buffer !== 'undefined'
          ? new Uint8Array(Buffer.from(config.identity.privateKey, 'base64'))
          : new Uint8Array(atob(config.identity.privateKey).split('').map(c => c.charCodeAt(0)));
        this._identityReady = AIPIdentity.fromPrivateKey(keyBytes)
          .then(id => { this._identity = id; })
          .catch(err => console.warn('[PrismerSDK] Identity init failed:', err));
      }
    }

    // Initialize OfflineManager if offline config is provided
    if (config.offline) {
      this._offlineManager = new OfflineManager(
        config.offline.storage,
        (m, p, b, q) => this._request(m, p, b, q),
        config.offline,
      );
      this._offlineManager.init().catch(err =>
        console.warn('[PrismerSDK] Offline storage init failed:', err)
      );
    }

    // IM requests go through OfflineManager when offline mode is enabled
    let imRequest: RequestFn = this._offlineManager
      ? <T>(m: string, p: string, b?: unknown, q?: Record<string, string>) =>
          this._offlineManager!.dispatch<T>(m, p, b, q)
      : <T>(m: string, p: string, b?: unknown, q?: Record<string, string>) =>
          this._request<T>(m, p, b, q);

    // v1.8.0 S1: Wrap with auto-signing for IM message sends
    if (config.identity) {
      const baseRequest = imRequest;
      imRequest = <T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> => {
        // Only sign POST requests to message endpoints
        if (method === 'POST' && path.includes('/messages') && body) {
          const b = body as Record<string, any>;
          if (!b.signature && !b.skipSigning) {
            // Await identity initialization before signing to avoid race condition
            const ready = this._identityReady || Promise.resolve();
            return ready.then(() => {
              if (this._identity) {
                return this._signAndSend<T>(baseRequest, method, path, b, query);
              }
              return baseRequest<T>(method, path, body, query);
            });
          }
        }
        return baseRequest<T>(method, path, body, query);
      };
    }

    this.im = new IMClient(
      imRequest,
      this.baseUrl,
      this.fetchFn,
      () => this._getAuthHeaders(),
      this._offlineManager,
      config.community ?? null,
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
  ): Promise<T> {
    if (this._identityReady) await this._identityReady;
    if (!this._identity) return baseRequest<T>(method, path, body, query);

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
    }, query);
  }

  /** Build auth headers for raw HTTP requests (used by file upload) */
  private _getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    if (this.imAgent) headers['X-IM-Agent'] = this.imAgent;
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

  // --------------------------------------------------------------------------
  // Internal request helper
  // --------------------------------------------------------------------------

  private async _request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    _isRetry?: boolean,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

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
        headers['X-IM-Agent'] = this.imAgent;
      }

      const init: RequestInit = { method, headers, signal: controller.signal };

      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }

      const response = await this.fetchFn(url, init);
      const data = await response.json();

      // Auto-refresh JWT token on 401 (one attempt, skip if already retrying)
      if (response.status === 401 && this.apiKey.startsWith('eyJ') && !_isRetry && !path.includes('/token/refresh')) {
        try {
          const refreshRes = await this._request<any>('POST', '/api/im/token/refresh', undefined, undefined, true);
          if (refreshRes?.ok && refreshRes?.data?.token) {
            this.apiKey = refreshRes.data.token;
            return this._request<T>(method, path, body, query, true);
          }
        } catch { /* refresh failed, return original error */ }
      }

      if (!response.ok) {
        const err = data.error || { code: 'HTTP_ERROR', message: `Request failed with status ${response.status}` };
        return { ...data, success: false, ok: false, error: err } as T;
      }

      return data as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, ok: false, error: { code: 'TIMEOUT', message: 'Request timed out' } } as T;
      }
      return {
        success: false,
        ok: false,
        error: { code: 'NETWORK_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      } as T;
    } finally {
      clearTimeout(timeoutId);
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
