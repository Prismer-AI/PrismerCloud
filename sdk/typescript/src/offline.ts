/**
 * Prismer SDK — Offline Manager, Outbox Queue, and Sync Engine.
 *
 * Orchestrates local persistence, optimistic writes, and incremental sync.
 */

import type { StorageAdapter, StoredMessage, StoredConversation, OutboxOperation } from './storage';
import type { RequestFn, IMResult, OfflineConfig } from './types';

// ============================================================================
// Sync Event Types
// ============================================================================

export interface SyncEvent {
  seq: number;
  type: string;
  data: any;
  conversationId?: string;
  at: string;
}

export interface SyncResult {
  events: SyncEvent[];
  cursor: number;
  hasMore: boolean;
}

// ============================================================================
// Offline Event Emitter
// ============================================================================

export interface OfflineEventMap {
  'sync.start': undefined;
  'sync.progress': { synced: number; total: number };
  'sync.complete': { newMessages: number; updatedConversations: number };
  'sync.error': { error: string; willRetry: boolean };
  'outbox.sending': { opId: string; type: string };
  'outbox.confirmed': { opId: string; serverData: any };
  'outbox.failed': { opId: string; error: string; retriesLeft: number };
  'message.local': StoredMessage;
  'message.confirmed': { clientId: string; serverMessage: any };
  'message.failed': { clientId: string; error: string };
  'network.online': undefined;
  'network.offline': undefined;
  'presence.changed': { userId: string; status: string; lastSeen?: string };
  'quota.warning': { used: number; limit: number; percentage: number };
  'quota.exceeded': { used: number; limit: number };
}

export type OfflineEventType = keyof OfflineEventMap;
type Listener<T> = (payload: T) => void;

class OfflineEmitter {
  private listeners = new Map<string, Set<Listener<any>>>();

  on<E extends OfflineEventType>(event: E, cb: Listener<OfflineEventMap[E]>): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
    return this;
  }

  off<E extends OfflineEventType>(event: E, cb: Listener<OfflineEventMap[E]>): this {
    this.listeners.get(event)?.delete(cb);
    return this;
  }

  emit<E extends OfflineEventType>(event: E, payload: OfflineEventMap[E]): void {
    const set = this.listeners.get(event);
    if (set) for (const cb of set) {
      try { cb(payload); } catch { /* user callback errors should not crash */ }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

// ============================================================================
// UUID Generator (no dependency)
// ============================================================================

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ============================================================================
// Write operation detection
// ============================================================================

/** Path patterns that are write operations (should go through outbox) */
const WRITE_PATTERNS: Array<{ method: string; pattern: RegExp; opType: OutboxOperation['type'] }> = [
  { method: 'POST', pattern: /\/api\/im\/(messages|direct|groups)\//, opType: 'message.send' },
  { method: 'PATCH', pattern: /\/api\/im\/messages\//, opType: 'message.edit' },
  { method: 'DELETE', pattern: /\/api\/im\/messages\//, opType: 'message.delete' },
  { method: 'POST', pattern: /\/api\/im\/conversations\/[^/]+\/read/, opType: 'conversation.read' },
];

function matchWriteOp(method: string, path: string): OutboxOperation['type'] | null {
  for (const { method: m, pattern, opType } of WRITE_PATTERNS) {
    if (method === m && pattern.test(path)) return opType;
  }
  return null;
}

/** Path patterns for cacheable reads */
const READ_CACHE_PATTERNS: Array<{ pattern: RegExp; handler: string }> = [
  { pattern: /\/api\/im\/conversations$/, handler: 'conversations.list' },
  { pattern: /\/api\/im\/conversations\/([^/]+)$/, handler: 'conversations.get' },
  { pattern: /\/api\/im\/messages\/([^/]+)$/, handler: 'messages.list' },
  { pattern: /\/api\/im\/contacts$/, handler: 'contacts.list' },
];

// ============================================================================
// Offline Manager
// ============================================================================

export class OfflineManager extends OfflineEmitter {
  readonly storage: StorageAdapter;
  private networkRequest: RequestFn;
  private options: {
    syncOnConnect: boolean;
    outboxRetryLimit: number;
    outboxFlushInterval: number;
    conflictStrategy: 'server' | 'client';
    onConflict?: OfflineConfig['onConflict'];
    syncMode: 'push' | 'poll';
    quota?: { maxStorageBytes: number; warningThreshold: number };
  };
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private _isOnline = true;
  private _syncState: 'idle' | 'syncing' | 'error' = 'idle';
  private sseSource: EventSource | null = null;
  private sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sseReconnectAttempts = 0;
  /** Presence cache for realtime presence events */
  private presenceCache = new Map<string, { status: string; lastSeen: string }>();
  /** Auth token provider — set by PrismerClient for SSE auth */
  tokenProvider?: () => string | undefined;

  get isOnline(): boolean { return this._isOnline; }
  get syncState(): string { return this._syncState; }

  constructor(
    storage: StorageAdapter,
    networkRequest: RequestFn,
    options: Omit<OfflineConfig, 'storage'> = {},
  ) {
    super();
    this.storage = storage;
    this.networkRequest = networkRequest;
    this.options = {
      syncOnConnect: options.syncOnConnect ?? true,
      outboxRetryLimit: options.outboxRetryLimit ?? 5,
      outboxFlushInterval: options.outboxFlushInterval ?? 1000,
      conflictStrategy: options.conflictStrategy ?? 'server',
      onConflict: options.onConflict,
      syncMode: options.syncMode ?? 'push',
      quota: options.quota ? {
        maxStorageBytes: options.quota.maxStorageBytes ?? 500 * 1024 * 1024,
        warningThreshold: options.quota.warningThreshold ?? 0.9,
      } : undefined,
    };
  }

  async init(): Promise<void> {
    await this.storage.init();
    this.startFlushTimer();
  }

  async destroy(): Promise<void> {
    this.stopFlushTimer();
    this.stopContinuousSync();
    this.removeAllListeners();
  }

  // ── Network state ─────────────────────────────────────────

  setOnline(online: boolean): void {
    if (this._isOnline === online) return;
    this._isOnline = online;
    this.emit(online ? 'network.online' : 'network.offline', undefined);
    if (online) {
      // Trigger immediate flush + sync
      this.flush();
      if (this.options.syncOnConnect) {
        if (this.options.syncMode === 'push') {
          this.startContinuousSync();
        } else {
          this.sync();
        }
      }
    } else {
      this.stopContinuousSync();
    }
  }

  // ── Request dispatch ──────────────────────────────────────

  /**
   * Dispatch an IM request. Write ops go through outbox; reads check local cache.
   */
  async dispatch<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    // Check if this is a write operation
    const opType = matchWriteOp(method, path);
    if (opType) {
      return this.dispatchWrite<T>(opType, method, path, body, query);
    }

    // For reads: try local cache first, fall through to network
    if (method === 'GET') {
      const cached = await this.readFromCache<T>(path, query);
      if (cached !== null) return cached;
    }

    // Network request, then cache the result
    try {
      const result = await this.networkRequest<T>(method, path, body, query);
      if (method === 'GET') this.cacheReadResult(path, query, result);
      return result;
    } catch {
      // If offline and we have no cache, return empty
      if (!this._isOnline) {
        return { ok: true, data: [] } as T;
      }
      throw new Error('Network request failed');
    }
  }

  // ── Outbox: write operations ──────────────────────────────

  private async dispatchWrite<T>(
    opType: OutboxOperation['type'],
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const clientId = generateId();
    const idempotencyKey = `sdk-${clientId}`;

    // Inject idempotency key into body metadata for server-side dedup
    let enrichedBody = body;
    if (body && typeof body === 'object' && (opType === 'message.send' || opType === 'message.edit')) {
      enrichedBody = { ...(body as Record<string, any>) };
      (enrichedBody as Record<string, any>).metadata = {
        ...(body as Record<string, any>).metadata,
        _idempotencyKey: idempotencyKey,
      };
    }

    // Build optimistic local message
    let localMessage: StoredMessage | undefined;
    if (opType === 'message.send' && body && typeof body === 'object') {
      const b = body as Record<string, any>;
      const convIdMatch = path.match(/\/(?:messages|direct|groups)\/([^/]+)/);
      const conversationId = convIdMatch?.[1] ?? '';
      localMessage = {
        id: `local-${clientId}`,
        clientId,
        conversationId,
        content: b.content ?? '',
        type: b.type ?? 'text',
        senderId: '__self__',
        parentId: b.parentId ?? null,
        status: 'pending',
        metadata: b.metadata,
        createdAt: new Date().toISOString(),
      };
      await this.storage.putMessages([localMessage]);
      this.emit('message.local', localMessage);
    }

    // Enqueue to outbox
    const op: OutboxOperation = {
      id: clientId,
      type: opType,
      method,
      path,
      body: enrichedBody,
      query,
      status: 'pending',
      createdAt: Date.now(),
      retries: 0,
      maxRetries: this.options.outboxRetryLimit,
      idempotencyKey,
      localData: localMessage,
    };
    await this.storage.enqueue(op);

    // If online, trigger immediate flush
    if (this._isOnline) this.flush();

    // Return optimistic result
    const optimisticResult = {
      ok: true,
      data: localMessage
        ? { conversationId: localMessage.conversationId, message: localMessage }
        : undefined,
      _pending: true,
      _clientId: clientId,
    } as T;

    return optimisticResult;
  }

  // ── Outbox flush ──────────────────────────────────────────

  private startFlushTimer(): void {
    this.stopFlushTimer();
    this.flushTimer = setInterval(() => this.flush(), this.options.outboxFlushInterval);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || !this._isOnline) return;
    this.flushing = true;

    try {
      const ops = await this.storage.dequeueReady(10);
      for (const op of ops) {
        this.emit('outbox.sending', { opId: op.id, type: op.type });
        try {
          const result = await this.networkRequest<IMResult>(
            op.method,
            op.path,
            op.body,
            op.query,
          );

          if (result.ok) {
            await this.storage.ack(op.id);
            this.emit('outbox.confirmed', { opId: op.id, serverData: result.data });

            // Update local message with server data
            if (op.type === 'message.send' && op.localData) {
              const local = op.localData as StoredMessage;
              const serverMsg = (result.data as any)?.message;
              if (serverMsg) {
                // Remove optimistic local message
                await this.storage.deleteMessage(local.id);
                // Store server-confirmed message
                await this.storage.putMessages([{
                  id: serverMsg.id,
                  clientId: op.id,
                  conversationId: serverMsg.conversationId ?? local.conversationId,
                  content: serverMsg.content ?? local.content,
                  type: serverMsg.type ?? local.type,
                  senderId: serverMsg.senderId ?? local.senderId,
                  parentId: serverMsg.parentId,
                  status: 'confirmed',
                  metadata: serverMsg.metadata ? (typeof serverMsg.metadata === 'string' ? JSON.parse(serverMsg.metadata) : serverMsg.metadata) : undefined,
                  createdAt: serverMsg.createdAt ?? local.createdAt,
                }]);
                this.emit('message.confirmed', { clientId: op.id, serverMessage: serverMsg });
              }
            }
          } else {
            const errCode = result.error?.code;
            // 4xx errors (except 429) are permanent failures
            if (errCode && !errCode.includes('TIMEOUT') && !errCode.includes('NETWORK')) {
              await this.storage.nack(op.id, result.error?.message ?? 'Request failed', op.maxRetries);
              this.emit('outbox.failed', { opId: op.id, error: result.error?.message ?? 'Request failed', retriesLeft: 0 });
              if (op.type === 'message.send') {
                this.emit('message.failed', { clientId: op.id, error: result.error?.message ?? 'Request failed' });
              }
            } else {
              // Transient error, retry
              await this.storage.nack(op.id, result.error?.message ?? 'Transient error', op.retries + 1);
              this.emit('outbox.failed', {
                opId: op.id,
                error: result.error?.message ?? 'Transient error',
                retriesLeft: op.maxRetries - op.retries - 1,
              });
            }
          }
        } catch (err) {
          // Network error
          const msg = err instanceof Error ? err.message : 'Unknown error';
          await this.storage.nack(op.id, msg, op.retries + 1);
          if (op.retries + 1 >= op.maxRetries) {
            this.emit('outbox.failed', { opId: op.id, error: msg, retriesLeft: 0 });
            if (op.type === 'message.send') {
              this.emit('message.failed', { clientId: op.id, error: msg });
            }
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  get outboxSize(): Promise<number> {
    return this.storage.getPendingCount();
  }

  // ── Sync engine ───────────────────────────────────────────

  async sync(): Promise<void> {
    if (this._syncState === 'syncing' || !this._isOnline) return;
    this._syncState = 'syncing';
    this.emit('sync.start', undefined);

    let totalNew = 0;
    let totalUpdated = 0;

    try {
      let cursor = await this.storage.getCursor('global_sync') ?? '0';
      let hasMore = true;

      while (hasMore) {
        const result = await this.networkRequest<IMResult<SyncResult>>(
          'GET', '/api/im/sync', undefined,
          { since: cursor, limit: '100' },
        );

        if (!result.ok || !result.data) {
          throw new Error(result.error?.message ?? 'Sync failed');
        }

        const { events, cursor: newCursor, hasMore: more } = result.data;

        for (const event of events) {
          await this.applySyncEvent(event);
          if (event.type === 'message.new') totalNew++;
          if (event.type.startsWith('conversation.')) totalUpdated++;
        }

        cursor = String(newCursor);
        await this.storage.setCursor('global_sync', cursor);
        hasMore = more;

        this.emit('sync.progress', { synced: events.length, total: events.length });
      }

      this._syncState = 'idle';
      this.emit('sync.complete', { newMessages: totalNew, updatedConversations: totalUpdated });
    } catch (err) {
      this._syncState = 'error';
      this.emit('sync.error', {
        error: err instanceof Error ? err.message : 'Sync failed',
        willRetry: false,
      });
    }
  }

  private async applySyncEvent(event: SyncEvent): Promise<void> {
    switch (event.type) {
      case 'message.new': {
        const msg = event.data;
        await this.storage.putMessages([{
          id: msg.id,
          conversationId: msg.conversationId ?? event.conversationId ?? '',
          content: msg.content ?? '',
          type: msg.type ?? 'text',
          senderId: msg.senderId ?? '',
          parentId: msg.parentId ?? null,
          status: 'confirmed',
          metadata: msg.metadata,
          createdAt: msg.createdAt ?? event.at,
          syncSeq: event.seq,
        }]);
        break;
      }
      case 'message.edit': {
        const existing = await this.storage.getMessage(event.data.id);
        if (existing) {
          // Conflict detection: local message has pending edits
          const hasLocalEdits = existing.status !== 'confirmed';
          if (hasLocalEdits && this.options.onConflict) {
            const resolution = this.options.onConflict(existing, event);
            if (resolution === 'keep_local') break;
            if (resolution !== 'accept_remote' && typeof resolution === 'object') {
              resolution.syncSeq = event.seq;
              await this.storage.putMessages([resolution]);
              break;
            }
          }
          existing.content = event.data.content ?? existing.content;
          existing.updatedAt = event.at;
          existing.syncSeq = event.seq;
          await this.storage.putMessages([existing]);
        }
        break;
      }
      case 'message.delete': {
        if (event.data?.id) await this.storage.deleteMessage(event.data.id);
        break;
      }
      case 'conversation.create':
      case 'conversation.update': {
        const conv = event.data;
        await this.storage.putConversations([{
          id: conv.id ?? event.conversationId ?? '',
          type: conv.type ?? 'direct',
          title: conv.title,
          unreadCount: conv.unreadCount ?? 0,
          members: conv.members,
          metadata: conv.metadata,
          syncSeq: event.seq,
          updatedAt: event.at,
          lastMessageAt: conv.lastMessageAt,
        }]);
        break;
      }
      case 'conversation.archive': {
        const convId = event.data?.id ?? event.conversationId;
        if (convId) {
          const existing = await this.storage.getConversation(convId);
          if (existing) {
            existing.metadata = { ...existing.metadata, _archived: true };
            existing.syncSeq = event.seq;
            existing.updatedAt = event.at;
            await this.storage.putConversations([existing]);
          }
        }
        break;
      }
      case 'participant.add': {
        const convId = event.data?.conversationId ?? event.conversationId;
        if (convId) {
          const existing = await this.storage.getConversation(convId);
          if (existing && existing.members) {
            const already = existing.members.find(m => m.userId === event.data.userId);
            if (!already) {
              existing.members.push({
                userId: event.data.userId,
                username: event.data.username ?? '',
                displayName: event.data.displayName,
                role: event.data.role ?? 'member',
              });
              existing.syncSeq = event.seq;
              existing.updatedAt = event.at;
              await this.storage.putConversations([existing]);
            }
          }
        }
        break;
      }
      case 'participant.remove': {
        const convId = event.data?.conversationId ?? event.conversationId;
        if (convId) {
          const existing = await this.storage.getConversation(convId);
          if (existing && existing.members) {
            existing.members = existing.members.filter(m => m.userId !== event.data.userId);
            existing.syncSeq = event.seq;
            existing.updatedAt = event.at;
            await this.storage.putConversations([existing]);
          }
        }
        break;
      }
    }
  }

  /**
   * Handle a realtime event (from WS/SSE) and store locally.
   */
  async handleRealtimeEvent(type: string, payload: any): Promise<void> {
    if (type === 'message.new' && payload) {
      await this.storage.putMessages([{
        id: payload.id,
        conversationId: payload.conversationId ?? '',
        content: payload.content ?? '',
        type: payload.type ?? 'text',
        senderId: payload.senderId ?? '',
        parentId: payload.parentId ?? null,
        status: 'confirmed',
        metadata: payload.metadata,
        createdAt: payload.createdAt ?? new Date().toISOString(),
      }]);
    }
    if (type === 'presence.changed' && payload?.userId) {
      this.presenceCache.set(payload.userId, {
        status: payload.status ?? 'offline',
        lastSeen: payload.lastSeen ?? new Date().toISOString(),
      });
      this.emit('presence.changed' as any, payload);
    }
  }

  /**
   * Get cached presence status for a user.
   */
  getPresence(userId: string): { status: string; lastSeen: string } | null {
    return this.presenceCache.get(userId) ?? null;
  }

  /**
   * Search messages in local storage.
   */
  async searchMessages(query: string, opts?: { conversationId?: string; limit?: number }): Promise<StoredMessage[]> {
    if (this.storage.searchMessages) {
      return this.storage.searchMessages(query, opts);
    }
    // Fallback: no search support in this storage adapter
    return [];
  }

  /**
   * Get storage size and quota info.
   */
  async getQuotaStatus(): Promise<{
    used: number;
    limit: number;
    percentage: number;
    warning: boolean;
    exceeded: boolean;
  }> {
    const limit = this.options.quota?.maxStorageBytes ?? 500 * 1024 * 1024;
    const threshold = this.options.quota?.warningThreshold ?? 0.9;
    if (this.storage.getStorageSize) {
      const size = await this.storage.getStorageSize();
      const percentage = size.total / limit;
      return {
        used: size.total,
        limit,
        percentage,
        warning: percentage >= threshold,
        exceeded: percentage >= 1,
      };
    }
    return { used: 0, limit, percentage: 0, warning: false, exceeded: false };
  }

  /**
   * Clear old messages for a conversation (user-initiated quota management).
   */
  async clearOldMessages(conversationId: string, keepCount: number): Promise<number> {
    if (this.storage.clearOldMessages) {
      return this.storage.clearOldMessages(conversationId, keepCount);
    }
    return 0;
  }

  // ── Read cache ────────────────────────────────────────────

  private async readFromCache<T>(path: string, query?: Record<string, string>): Promise<T | null> {
    // Match conversations list
    if (/\/api\/im\/conversations$/.test(path)) {
      const convos = await this.storage.getConversations({ limit: 50 });
      if (convos.length > 0) return { ok: true, data: convos } as T;
    }

    // Match message history
    const msgMatch = path.match(/\/api\/im\/messages\/([^/]+)$/);
    if (msgMatch) {
      const convId = msgMatch[1];
      const limit = query?.limit ? parseInt(query.limit) : 50;
      const messages = await this.storage.getMessages(convId, { limit, before: query?.before });
      if (messages.length > 0) return { ok: true, data: messages } as T;
    }

    // Match contacts
    if (/\/api\/im\/contacts$/.test(path)) {
      const contacts = await this.storage.getContacts();
      if (contacts.length > 0) return { ok: true, data: contacts } as T;
    }

    return null;
  }

  private async cacheReadResult(path: string, _query: Record<string, string> | undefined, result: any): Promise<void> {
    if (!result?.ok || !result?.data) return;

    try {
      if (/\/api\/im\/conversations$/.test(path) && Array.isArray(result.data)) {
        const convos: StoredConversation[] = result.data.map((c: any) => ({
          id: c.id,
          type: c.type ?? 'direct',
          title: c.title,
          lastMessage: c.lastMessage,
          lastMessageAt: c.lastMessageAt ?? c.updatedAt,
          unreadCount: c.unreadCount ?? 0,
          members: c.members,
          metadata: c.metadata,
          updatedAt: c.updatedAt ?? new Date().toISOString(),
        }));
        await this.storage.putConversations(convos);
      }

      const msgMatch = path.match(/\/api\/im\/messages\/([^/]+)$/);
      if (msgMatch && Array.isArray(result.data)) {
        const messages: StoredMessage[] = result.data.map((m: any) => ({
          id: m.id,
          conversationId: m.conversationId ?? msgMatch[1],
          content: m.content ?? '',
          type: m.type ?? 'text',
          senderId: m.senderId ?? '',
          parentId: m.parentId ?? null,
          status: 'confirmed' as const,
          metadata: m.metadata,
          createdAt: m.createdAt ?? new Date().toISOString(),
        }));
        await this.storage.putMessages(messages);
      }

      if (/\/api\/im\/contacts$/.test(path) && Array.isArray(result.data)) {
        await this.storage.putContacts(result.data);
      }
    } catch {
      // Caching errors are non-fatal
    }
  }

  // ── SSE continuous sync ────────────────────────────────────

  /**
   * Start continuous sync via SSE (Server-Sent Events).
   * Replaces polling with real-time push when syncMode is 'push'.
   */
  async startContinuousSync(): Promise<void> {
    if (this.sseSource) return; // Already connected
    if (typeof EventSource === 'undefined') {
      // SSE not available (Node.js without polyfill) — fallback to polling
      return this.sync();
    }

    const token = this.tokenProvider?.();
    if (!token) {
      // No token, can't authenticate SSE — fallback to polling
      return this.sync();
    }

    const cursor = await this.storage.getCursor('global_sync') ?? '0';
    const baseUrl = this.getBaseUrl();
    const url = `${baseUrl}/api/im/sync/stream?token=${encodeURIComponent(token)}&since=${cursor}`;

    this._syncState = 'syncing';
    this.emit('sync.start', undefined);
    this.sseReconnectAttempts = 0;

    try {
      this.sseSource = new EventSource(url);
      let totalNew = 0;
      let totalUpdated = 0;

      this.sseSource.addEventListener('sync', async (e: MessageEvent) => {
        try {
          const event: SyncEvent = JSON.parse(e.data);
          await this.applySyncEvent(event);
          await this.storage.setCursor('global_sync', String(event.seq));
          if (event.type === 'message.new') totalNew++;
          if (event.type.startsWith('conversation.')) totalUpdated++;
          this.emit('sync.progress', { synced: 1, total: 1 });

          // Check quota after each event
          if (this.options.quota) {
            await this.checkQuota();
          }
        } catch {
          // Individual event processing errors are non-fatal
        }
      });

      this.sseSource.addEventListener('caught_up', () => {
        this._syncState = 'idle';
        this.sseReconnectAttempts = 0;
        this.emit('sync.complete', { newMessages: totalNew, updatedConversations: totalUpdated });
        totalNew = 0;
        totalUpdated = 0;
      });

      this.sseSource.addEventListener('error', () => {
        // EventSource auto-reconnects, but we track state
        this._syncState = 'error';
        this.emit('sync.error', { error: 'SSE connection error', willRetry: true });
      });

      this.sseSource.onerror = () => {
        if (this.sseSource?.readyState === EventSource.CLOSED) {
          this.sseSource = null;
          this._syncState = 'error';
          // Manual reconnect with backoff
          this.scheduleSseReconnect();
        }
      };
    } catch (err) {
      this._syncState = 'error';
      this.emit('sync.error', {
        error: err instanceof Error ? err.message : 'SSE init failed',
        willRetry: true,
      });
      this.scheduleSseReconnect();
    }
  }

  /**
   * Stop the SSE continuous sync connection.
   */
  stopContinuousSync(): void {
    if (this.sseSource) {
      this.sseSource.close();
      this.sseSource = null;
    }
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = null;
    }
    this._syncState = 'idle';
  }

  private scheduleSseReconnect(): void {
    if (!this._isOnline) return;
    this.sseReconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.sseReconnectAttempts - 1), 30000);
    this.sseReconnectTimer = setTimeout(() => {
      this.sseReconnectTimer = null;
      if (this._isOnline) this.startContinuousSync();
    }, delay);
  }

  /** Get the base URL for SSE connections (strip /api/im prefix). */
  private getBaseUrl(): string {
    // Try to extract base URL from a test network request path
    // This is a heuristic — PrismerClient should set tokenProvider
    return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  }

  // ── Quota check ─────────────────────────────────────────────

  private async checkQuota(): Promise<void> {
    if (!this.options.quota || !this.storage.getStorageSize) return;
    const size = await this.storage.getStorageSize();
    const limit = this.options.quota.maxStorageBytes;
    const threshold = this.options.quota.warningThreshold;
    const pct = size.total / limit;

    if (pct >= 1) {
      this.emit('quota.exceeded', { used: size.total, limit });
    } else if (pct >= threshold) {
      this.emit('quota.warning', { used: size.total, limit, percentage: pct });
    }
  }
}

// ============================================================================
// Attachment Offline Queue
// ============================================================================

export interface QueuedAttachment {
  id: string;
  conversationId: string;
  file: { name: string; size: number; type: string };
  /** File data — stored in memory for MemoryStorage, in IndexedDB/SQLite for persistent */
  data?: ArrayBuffer;
  status: 'pending' | 'uploading' | 'uploaded' | 'failed';
  progress: number;
  messageClientId: string;
  error?: string;
  createdAt: number;
}

/**
 * AttachmentQueue manages offline file uploads.
 * Files are queued locally and uploaded when online, then a message
 * is sent referencing the uploaded file.
 */
export class AttachmentQueue {
  private queue = new Map<string, QueuedAttachment>();
  private uploading = false;

  constructor(
    private offline: OfflineManager,
    private networkRequest: RequestFn,
  ) {}

  /**
   * Queue a file attachment for offline upload.
   * Returns the queued attachment with a local ID.
   */
  async queueAttachment(
    conversationId: string,
    file: { name: string; size: number; type: string; data: ArrayBuffer },
    messageContent?: string,
  ): Promise<QueuedAttachment> {
    const id = generateId();
    const attachment: QueuedAttachment = {
      id,
      conversationId,
      file: { name: file.name, size: file.size, type: file.type },
      data: file.data,
      status: 'pending',
      progress: 0,
      messageClientId: generateId(),
      createdAt: Date.now(),
    };
    this.queue.set(id, attachment);

    // Create optimistic local message with attachment placeholder
    await this.offline.storage.putMessages([{
      id: `local-${attachment.messageClientId}`,
      clientId: attachment.messageClientId,
      conversationId,
      content: messageContent ?? `[File: ${file.name}]`,
      type: 'file',
      senderId: '__self__',
      status: 'pending',
      metadata: { _attachmentId: id, fileName: file.name, fileSize: file.size },
      createdAt: new Date().toISOString(),
    }]);

    // If online, start upload
    if (this.offline.isOnline) this.processQueue();

    return attachment;
  }

  /** Process pending uploads. */
  async processQueue(): Promise<void> {
    if (this.uploading || !this.offline.isOnline) return;
    this.uploading = true;

    try {
      for (const [id, att] of this.queue) {
        if (att.status !== 'pending') continue;
        att.status = 'uploading';

        try {
          // Step 1: Presign upload
          const presign = await this.networkRequest<any>(
            'POST', '/api/im/files/presign',
            { fileName: att.file.name, fileSize: att.file.size, mimeType: att.file.type },
          );

          if (!presign.ok || !presign.data?.uploadUrl) {
            throw new Error(presign.error?.message ?? 'Presign failed');
          }

          // Step 2: Upload file data
          if (att.data) {
            await fetch(presign.data.uploadUrl, {
              method: 'PUT',
              body: att.data,
              headers: { 'Content-Type': att.file.type },
            });
          }
          att.progress = 80;

          // Step 3: Confirm upload
          const confirm = await this.networkRequest<any>(
            'POST', '/api/im/files/confirm',
            { uploadId: presign.data.uploadId },
          );

          if (!confirm.ok) {
            throw new Error(confirm.error?.message ?? 'Confirm failed');
          }

          att.status = 'uploaded';
          att.progress = 100;

          // Step 4: Send message with file reference
          await this.networkRequest<any>(
            'POST', `/api/im/messages/${att.conversationId}`,
            {
              type: 'file',
              content: `[File: ${att.file.name}]`,
              metadata: {
                fileUrl: confirm.data?.url ?? presign.data.downloadUrl,
                fileName: att.file.name,
                fileSize: att.file.size,
                mimeType: att.file.type,
                uploadId: presign.data.uploadId,
              },
            },
          );

          // Clean up local optimistic message
          await this.offline.storage.deleteMessage(`local-${att.messageClientId}`);
          this.queue.delete(id);
        } catch (err) {
          att.status = 'failed';
          att.error = err instanceof Error ? err.message : 'Upload failed';
        }
      }
    } finally {
      this.uploading = false;
    }
  }

  /** Get all queued attachments. */
  getQueue(): QueuedAttachment[] {
    return Array.from(this.queue.values());
  }

  /** Retry a failed attachment upload. */
  async retry(attachmentId: string): Promise<void> {
    const att = this.queue.get(attachmentId);
    if (att && att.status === 'failed') {
      att.status = 'pending';
      att.error = undefined;
      if (this.offline.isOnline) this.processQueue();
    }
  }

  /** Cancel and remove a queued attachment. */
  async cancel(attachmentId: string): Promise<void> {
    const att = this.queue.get(attachmentId);
    if (att) {
      await this.offline.storage.deleteMessage(`local-${att.messageClientId}`);
      this.queue.delete(attachmentId);
    }
  }
}
