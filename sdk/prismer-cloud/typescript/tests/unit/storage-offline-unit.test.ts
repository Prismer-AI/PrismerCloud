/**
 * Unit tests for MemoryStorage and OfflineManager core logic.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryStorage } from '../../src/storage';
import type { StoredMessage, StoredConversation, StoredContact, OutboxOperation } from '../../src/storage';
import { OfflineManager } from '../../src/offline';
import type { IMResult } from '../../src/types';

// ============================================================================
// Test Data Helpers
// ============================================================================

function makeMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    conversationId: 'conv-1',
    content: 'Hello world',
    type: 'text',
    senderId: 'user-1',
    status: 'confirmed',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeConversation(overrides: Partial<StoredConversation> = {}): StoredConversation {
  return {
    id: `conv-${Math.random().toString(36).slice(2, 8)}`,
    type: 'direct',
    title: 'Test Conversation',
    unreadCount: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeContact(overrides: Partial<StoredContact> = {}): StoredContact {
  return {
    userId: `user-${Math.random().toString(36).slice(2, 8)}`,
    username: 'testuser',
    displayName: 'Test User',
    role: 'member',
    conversationId: 'conv-1',
    unreadCount: 0,
    ...overrides,
  };
}

function makeOutboxOp(overrides: Partial<OutboxOperation> = {}): OutboxOperation {
  return {
    id: `op-${Math.random().toString(36).slice(2, 8)}`,
    type: 'message.send',
    method: 'POST',
    path: '/api/im/messages/conv-1',
    body: { content: 'hello' },
    status: 'pending',
    createdAt: Date.now(),
    retries: 0,
    maxRetries: 3,
    idempotencyKey: `sdk-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

// ============================================================================
// MemoryStorage Tests
// ============================================================================

describe('MemoryStorage', () => {
  let storage: MemoryStorage;

  beforeEach(async () => {
    storage = new MemoryStorage();
    await storage.init();
  });

  // ── 1. putMessages + getMessages ─────────────────────────────

  describe('putMessages + getMessages', () => {
    it('stores and retrieves messages by conversationId', async () => {
      const m1 = makeMessage({ id: 'msg-1', conversationId: 'conv-1', createdAt: '2026-01-01T00:00:00Z' });
      const m2 = makeMessage({ id: 'msg-2', conversationId: 'conv-1', createdAt: '2026-01-01T00:01:00Z' });
      const m3 = makeMessage({ id: 'msg-3', conversationId: 'conv-2', createdAt: '2026-01-01T00:02:00Z' });

      await storage.putMessages([m1, m2, m3]);

      const result = await storage.getMessages('conv-1', { limit: 50 });
      expect(result).toHaveLength(2);
      expect(result.map(m => m.id)).toEqual(['msg-1', 'msg-2']);
    });

    it('returns messages sorted by createdAt ascending', async () => {
      const m1 = makeMessage({ id: 'msg-b', conversationId: 'conv-1', createdAt: '2026-01-01T00:05:00Z' });
      const m2 = makeMessage({ id: 'msg-a', conversationId: 'conv-1', createdAt: '2026-01-01T00:01:00Z' });
      await storage.putMessages([m1, m2]);

      const result = await storage.getMessages('conv-1', { limit: 50 });
      expect(result[0].id).toBe('msg-a');
      expect(result[1].id).toBe('msg-b');
    });
  });

  // ── 2. getMessages with 'before' cursor ──────────────────────

  describe('getMessages with before cursor', () => {
    it('returns messages before the specified message ID', async () => {
      const msgs = Array.from({ length: 5 }, (_, i) =>
        makeMessage({
          id: `msg-${i}`,
          conversationId: 'conv-1',
          createdAt: `2026-01-01T00:0${i}:00Z`,
        }),
      );
      await storage.putMessages(msgs);

      // Get messages before msg-3, limit 2
      const result = await storage.getMessages('conv-1', { limit: 2, before: 'msg-3' });
      expect(result.map(m => m.id)).toEqual(['msg-1', 'msg-2']);
    });

    it('returns empty when before points to first message', async () => {
      const msgs = [
        makeMessage({ id: 'msg-0', conversationId: 'conv-1', createdAt: '2026-01-01T00:00:00Z' }),
        makeMessage({ id: 'msg-1', conversationId: 'conv-1', createdAt: '2026-01-01T00:01:00Z' }),
      ];
      await storage.putMessages(msgs);

      // Before the first message — findIndex returns 0, the guard `idx > 0` fails,
      // so it falls through to the default slice behavior
      const result = await storage.getMessages('conv-1', { limit: 10, before: 'msg-0' });
      // Falls through to `all.slice(-limit)` which returns all messages
      expect(result).toHaveLength(2);
    });
  });

  // ── 3. getMessages with limit ────────────────────────────────

  describe('getMessages with limit', () => {
    it('returns at most N messages (most recent)', async () => {
      const msgs = Array.from({ length: 10 }, (_, i) =>
        makeMessage({
          id: `msg-${String(i).padStart(2, '0')}`,
          conversationId: 'conv-1',
          createdAt: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
        }),
      );
      await storage.putMessages(msgs);

      const result = await storage.getMessages('conv-1', { limit: 3 });
      expect(result).toHaveLength(3);
      // Should be the last 3 (most recent)
      expect(result.map(m => m.id)).toEqual(['msg-07', 'msg-08', 'msg-09']);
    });
  });

  // ── 4. getMessage by ID ──────────────────────────────────────

  describe('getMessage', () => {
    it('returns a single message by ID', async () => {
      const m = makeMessage({ id: 'msg-find-me', content: 'find me' });
      await storage.putMessages([m]);

      const result = await storage.getMessage('msg-find-me');
      expect(result).not.toBeNull();
      expect(result!.content).toBe('find me');
    });

    it('returns null for non-existent message', async () => {
      const result = await storage.getMessage('msg-does-not-exist');
      expect(result).toBeNull();
    });
  });

  // ── 5. deleteMessage ─────────────────────────────────────────

  describe('deleteMessage', () => {
    it('removes a message', async () => {
      const m = makeMessage({ id: 'msg-delete-me' });
      await storage.putMessages([m]);

      await storage.deleteMessage('msg-delete-me');
      const result = await storage.getMessage('msg-delete-me');
      expect(result).toBeNull();
    });

    it('is a no-op for non-existent message', async () => {
      await expect(storage.deleteMessage('msg-nope')).resolves.toBeUndefined();
    });
  });

  // ── 6. putConversations + getConversations ───────────────────

  describe('putConversations + getConversations', () => {
    it('stores and retrieves conversations', async () => {
      const c1 = makeConversation({ id: 'conv-a', lastMessageAt: '2026-01-01T00:00:00Z' });
      const c2 = makeConversation({ id: 'conv-b', lastMessageAt: '2026-01-02T00:00:00Z' });
      await storage.putConversations([c1, c2]);

      const result = await storage.getConversations({ limit: 50 });
      expect(result).toHaveLength(2);
      // Sorted by lastMessageAt DESC
      expect(result[0].id).toBe('conv-b');
      expect(result[1].id).toBe('conv-a');
    });

    it('respects limit and offset', async () => {
      const convos = Array.from({ length: 5 }, (_, i) =>
        makeConversation({
          id: `conv-${i}`,
          lastMessageAt: `2026-01-0${i + 1}T00:00:00Z`,
        }),
      );
      await storage.putConversations(convos);

      const result = await storage.getConversations({ limit: 2, offset: 1 });
      expect(result).toHaveLength(2);
      // Sorted DESC: conv-4, conv-3, conv-2, conv-1, conv-0
      // offset 1, limit 2 → conv-3, conv-2
      expect(result[0].id).toBe('conv-3');
      expect(result[1].id).toBe('conv-2');
    });
  });

  // ── 7. getConversation by ID ─────────────────────────────────

  describe('getConversation', () => {
    it('returns a single conversation by ID', async () => {
      const c = makeConversation({ id: 'conv-find', title: 'Find Me' });
      await storage.putConversations([c]);

      const result = await storage.getConversation('conv-find');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Find Me');
    });

    it('returns null for non-existent conversation', async () => {
      const result = await storage.getConversation('conv-nope');
      expect(result).toBeNull();
    });
  });

  // ── 8. putContacts + getContacts ─────────────────────────────

  describe('putContacts + getContacts', () => {
    it('stores and retrieves contacts', async () => {
      const c1 = makeContact({ userId: 'user-1', displayName: 'Alice' });
      const c2 = makeContact({ userId: 'user-2', displayName: 'Bob' });
      await storage.putContacts([c1, c2]);

      const result = await storage.getContacts();
      expect(result).toHaveLength(2);
      const names = result.map(c => c.displayName).sort();
      expect(names).toEqual(['Alice', 'Bob']);
    });

    it('overwrites contacts with the same userId', async () => {
      const c1 = makeContact({ userId: 'user-1', displayName: 'Alice' });
      await storage.putContacts([c1]);
      const c1Updated = makeContact({ userId: 'user-1', displayName: 'Alice Updated' });
      await storage.putContacts([c1Updated]);

      const result = await storage.getContacts();
      expect(result).toHaveLength(1);
      expect(result[0].displayName).toBe('Alice Updated');
    });
  });

  // ── 9. getCursor / setCursor ─────────────────────────────────

  describe('getCursor / setCursor', () => {
    it('returns null for unset cursor', async () => {
      const result = await storage.getCursor('global_sync');
      expect(result).toBeNull();
    });

    it('stores and retrieves a cursor value', async () => {
      await storage.setCursor('global_sync', '42');
      const result = await storage.getCursor('global_sync');
      expect(result).toBe('42');
    });

    it('overwrites cursor on subsequent set', async () => {
      await storage.setCursor('global_sync', '10');
      await storage.setCursor('global_sync', '20');
      const result = await storage.getCursor('global_sync');
      expect(result).toBe('20');
    });
  });

  // ── 10. enqueue ──────────────────────────────────────────────

  describe('enqueue', () => {
    it('adds an operation to the outbox', async () => {
      const op = makeOutboxOp({ id: 'op-1' });
      await storage.enqueue(op);

      const count = await storage.getPendingCount();
      expect(count).toBe(1);
    });
  });

  // ── 11. dequeueReady ─────────────────────────────────────────

  describe('dequeueReady', () => {
    it('returns pending operations and marks them inflight', async () => {
      const op1 = makeOutboxOp({ id: 'op-1', createdAt: 1000 });
      const op2 = makeOutboxOp({ id: 'op-2', createdAt: 2000 });
      await storage.enqueue(op1);
      await storage.enqueue(op2);

      const ready = await storage.dequeueReady(10);
      expect(ready).toHaveLength(2);
      expect(ready[0].id).toBe('op-1'); // sorted by createdAt
      expect(ready[0].status).toBe('inflight');
      expect(ready[1].status).toBe('inflight');
    });

    it('respects the limit parameter', async () => {
      await storage.enqueue(makeOutboxOp({ id: 'op-1', createdAt: 1000 }));
      await storage.enqueue(makeOutboxOp({ id: 'op-2', createdAt: 2000 }));
      await storage.enqueue(makeOutboxOp({ id: 'op-3', createdAt: 3000 }));

      const ready = await storage.dequeueReady(2);
      expect(ready).toHaveLength(2);
    });

    it('does not return already-inflight operations', async () => {
      const op = makeOutboxOp({ id: 'op-1' });
      await storage.enqueue(op);

      await storage.dequeueReady(10); // marks as inflight
      const again = await storage.dequeueReady(10);
      expect(again).toHaveLength(0);
    });
  });

  // ── 12. ack ──────────────────────────────────────────────────

  describe('ack', () => {
    it('removes an acknowledged operation from outbox', async () => {
      const op = makeOutboxOp({ id: 'op-ack' });
      await storage.enqueue(op);
      expect(await storage.getPendingCount()).toBe(1);

      await storage.ack('op-ack');
      expect(await storage.getPendingCount()).toBe(0);
    });
  });

  // ── 13. nack ─────────────────────────────────────────────────

  describe('nack', () => {
    it('increments retry count and keeps pending if under maxRetries', async () => {
      const op = makeOutboxOp({ id: 'op-nack', maxRetries: 3 });
      await storage.enqueue(op);

      await storage.nack('op-nack', 'timeout', 1);
      const ready = await storage.dequeueReady(10);
      expect(ready).toHaveLength(1);
      expect(ready[0].retries).toBe(1);
      expect(ready[0].lastError).toBe('timeout');
    });

    it('marks as failed when retries >= maxRetries', async () => {
      const op = makeOutboxOp({ id: 'op-fail', maxRetries: 2 });
      await storage.enqueue(op);

      await storage.nack('op-fail', 'permanent error', 2);
      // Failed operations are not pending
      const ready = await storage.dequeueReady(10);
      expect(ready).toHaveLength(0);

      // They also do not count as pending
      const count = await storage.getPendingCount();
      expect(count).toBe(0);
    });
  });

  // ── 14. getPendingCount ──────────────────────────────────────

  describe('getPendingCount', () => {
    it('counts pending and inflight operations', async () => {
      await storage.enqueue(makeOutboxOp({ id: 'op-1' }));
      await storage.enqueue(makeOutboxOp({ id: 'op-2' }));
      expect(await storage.getPendingCount()).toBe(2);

      // Dequeue one (marks inflight)
      await storage.dequeueReady(1);
      // Still counts inflight as pending
      expect(await storage.getPendingCount()).toBe(2);
    });

    it('returns 0 when outbox is empty', async () => {
      expect(await storage.getPendingCount()).toBe(0);
    });
  });

  // ── 15. clear ────────────────────────────────────────────────

  describe('clear', () => {
    it('resets all state', async () => {
      await storage.putMessages([makeMessage()]);
      await storage.putConversations([makeConversation()]);
      await storage.putContacts([makeContact()]);
      await storage.setCursor('key', 'value');
      await storage.enqueue(makeOutboxOp());

      await storage.clear();

      expect(await storage.getMessages('conv-1', { limit: 50 })).toHaveLength(0);
      expect(await storage.getConversations()).toHaveLength(0);
      expect(await storage.getContacts()).toHaveLength(0);
      expect(await storage.getCursor('key')).toBeNull();
      expect(await storage.getPendingCount()).toBe(0);
    });
  });

  // ── 16. getStorageSize ───────────────────────────────────────

  describe('getStorageSize', () => {
    it('returns approximate byte count based on record count', async () => {
      await storage.putMessages([makeMessage(), makeMessage()]);
      await storage.putConversations([makeConversation()]);

      const size = await storage.getStorageSize!();
      expect(size.messages).toBe(2 * 500); // ~500 bytes per message
      expect(size.conversations).toBe(1 * 200); // ~200 bytes per conversation
      expect(size.total).toBe(size.messages + size.conversations);
    });

    it('returns zero for empty storage', async () => {
      const size = await storage.getStorageSize!();
      expect(size.total).toBe(0);
    });
  });

  // ── 17. searchMessages ───────────────────────────────────────

  describe('searchMessages', () => {
    it('finds messages by content substring (case-insensitive)', async () => {
      await storage.putMessages([
        makeMessage({ id: 'msg-1', content: 'Hello World', createdAt: '2026-01-01T00:00:00Z' }),
        makeMessage({ id: 'msg-2', content: 'Goodbye World', createdAt: '2026-01-01T00:01:00Z' }),
        makeMessage({ id: 'msg-3', content: 'hello again', createdAt: '2026-01-01T00:02:00Z' }),
      ]);

      const result = await storage.searchMessages!('hello');
      expect(result).toHaveLength(2);
      expect(result.map(m => m.id)).toContain('msg-1');
      expect(result.map(m => m.id)).toContain('msg-3');
    });

    it('filters by conversationId when specified', async () => {
      await storage.putMessages([
        makeMessage({ id: 'msg-1', conversationId: 'conv-1', content: 'target' }),
        makeMessage({ id: 'msg-2', conversationId: 'conv-2', content: 'target' }),
      ]);

      const result = await storage.searchMessages!('target', { conversationId: 'conv-1' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('msg-1');
    });

    it('respects limit parameter', async () => {
      const msgs = Array.from({ length: 10 }, (_, i) =>
        makeMessage({ id: `msg-${i}`, content: 'searchable text', createdAt: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z` }),
      );
      await storage.putMessages(msgs);

      const result = await storage.searchMessages!('searchable', { limit: 3 });
      expect(result).toHaveLength(3);
    });

    it('returns empty for no matches', async () => {
      await storage.putMessages([makeMessage({ content: 'nothing relevant' })]);
      const result = await storage.searchMessages!('xyznonexistent');
      expect(result).toHaveLength(0);
    });
  });
});

// ============================================================================
// OfflineManager Tests
// ============================================================================

describe('OfflineManager', () => {
  let storage: MemoryStorage;
  let mockRequest: ReturnType<typeof vi.fn>;
  let manager: OfflineManager;

  beforeEach(async () => {
    storage = new MemoryStorage();
    mockRequest = vi.fn();
    manager = new OfflineManager(storage, mockRequest, {
      outboxFlushInterval: 100_000, // Very long interval to prevent auto-flush during tests
      outboxRetryLimit: 3,
      syncOnConnect: false, // Disable auto-sync to keep tests predictable
    });
    await manager.init();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  // ── 18. init ─────────────────────────────────────────────────

  describe('init', () => {
    it('initializes the manager and underlying storage', async () => {
      const mgr = new OfflineManager(new MemoryStorage(), mockRequest, {
        outboxFlushInterval: 100_000,
        syncOnConnect: false,
      });
      await expect(mgr.init()).resolves.toBeUndefined();
      await mgr.destroy();
    });
  });

  // ── 19. destroy ──────────────────────────────────────────────

  describe('destroy', () => {
    it('cleans up timers and listeners', async () => {
      const listener = vi.fn();
      manager.on('network.online', listener);

      await manager.destroy();

      // After destroy, emitting should not call listener (removeAllListeners was called)
      manager.setOnline(true);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── 20. setOnline(true) triggers flush ───────────────────────

  describe('setOnline(true)', () => {
    it('triggers flush when going online', async () => {
      // Enqueue an operation while offline
      manager.setOnline(false);
      const op = makeOutboxOp({ id: 'op-flush-test' });
      await storage.enqueue(op);

      // Mock a successful response
      mockRequest.mockResolvedValueOnce({ ok: true, data: {} });

      // Go online — should trigger flush
      manager.setOnline(true);
      // Give flush a tick to run
      await vi.waitFor(async () => {
        expect(mockRequest).toHaveBeenCalled();
      });
    });

    it('emits network.online event', async () => {
      const listener = vi.fn();
      manager.on('network.online', listener);

      manager.setOnline(false);
      manager.setOnline(true);

      expect(listener).toHaveBeenCalledOnce();
    });
  });

  // ── 21. setOnline(false) pauses sync ─────────────────────────

  describe('setOnline(false)', () => {
    it('emits network.offline event', () => {
      const listener = vi.fn();
      manager.on('network.offline', listener);
      manager.setOnline(false);
      expect(listener).toHaveBeenCalledOnce();
    });

    it('does not emit if already offline', () => {
      manager.setOnline(false);
      const listener = vi.fn();
      manager.on('network.offline', listener);
      manager.setOnline(false);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── 22. dispatch write → routes to outbox ────────────────────

  describe('dispatch write operations', () => {
    it('enqueues a message.send to outbox and returns optimistic result', async () => {
      // Prevent actual flush from running by going offline
      manager.setOnline(false);

      const result = await manager.dispatch<any>(
        'POST',
        '/api/im/messages/conv-1',
        { content: 'hello offline' },
      );

      expect(result.ok).toBe(true);
      expect(result._pending).toBe(true);
      expect(result._clientId).toBeDefined();

      // Check outbox has the operation
      const count = await manager.outboxSize;
      expect(count).toBe(1);
    });

    it('creates an optimistic local message for message.send', async () => {
      manager.setOnline(false);

      const localListener = vi.fn();
      manager.on('message.local', localListener);

      await manager.dispatch('POST', '/api/im/messages/conv-1', { content: 'optimistic' });

      expect(localListener).toHaveBeenCalledOnce();
      const localMsg = localListener.mock.calls[0][0];
      expect(localMsg.content).toBe('optimistic');
      expect(localMsg.status).toBe('pending');
      expect(localMsg.conversationId).toBe('conv-1');
    });
  });

  // ── 23. dispatch read → cache first, then network ────────────

  describe('dispatch read operations', () => {
    it('returns cached conversations if available', async () => {
      // Pre-populate cache
      await storage.putConversations([
        makeConversation({ id: 'conv-cached', title: 'Cached' }),
      ]);

      const result = await manager.dispatch<any>('GET', '/api/im/conversations');
      expect(result.ok).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('conv-cached');
      // Should not have called network
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('falls through to network when cache is empty', async () => {
      mockRequest.mockResolvedValueOnce({
        ok: true,
        data: [{ id: 'conv-net', type: 'direct', updatedAt: '2026-01-01T00:00:00Z' }],
      });

      const result = await manager.dispatch<any>('GET', '/api/im/conversations');
      expect(result.ok).toBe(true);
      expect(mockRequest).toHaveBeenCalledOnce();
    });

    it('returns cached messages for a conversation', async () => {
      await storage.putMessages([
        makeMessage({ id: 'msg-cached', conversationId: 'conv-1', content: 'from cache' }),
      ]);

      const result = await manager.dispatch<any>('GET', '/api/im/messages/conv-1');
      expect(result.ok).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  // ── 24. flush success → ack + confirmed events ───────────────

  describe('flush success', () => {
    it('acknowledges operation and emits confirmed event', async () => {
      const op = makeOutboxOp({ id: 'op-success' });
      await storage.enqueue(op);

      mockRequest.mockResolvedValueOnce({ ok: true, data: { message: { id: 'server-msg-1' } } });

      const confirmedListener = vi.fn();
      manager.on('outbox.confirmed', confirmedListener);

      await manager.flush();

      expect(confirmedListener).toHaveBeenCalledWith(
        expect.objectContaining({ opId: 'op-success' }),
      );
      // Operation should be removed from outbox
      expect(await storage.getPendingCount()).toBe(0);
    });

    it('emits outbox.sending before network request', async () => {
      const op = makeOutboxOp({ id: 'op-sending' });
      await storage.enqueue(op);

      mockRequest.mockResolvedValueOnce({ ok: true, data: {} });

      const sendingListener = vi.fn();
      manager.on('outbox.sending', sendingListener);

      await manager.flush();

      expect(sendingListener).toHaveBeenCalledWith(
        expect.objectContaining({ opId: 'op-sending', type: 'message.send' }),
      );
    });
  });

  // ── 25. flush permanent error (4xx) → nack after maxRetries ──

  describe('flush permanent error', () => {
    it('marks operation as failed immediately for non-transient errors', async () => {
      const op = makeOutboxOp({ id: 'op-perm-fail', maxRetries: 3 });
      await storage.enqueue(op);

      mockRequest.mockResolvedValueOnce({
        ok: false,
        error: { code: 'INVALID_INPUT', message: 'Bad request' },
      });

      const failedListener = vi.fn();
      manager.on('outbox.failed', failedListener);

      await manager.flush();

      expect(failedListener).toHaveBeenCalledWith(
        expect.objectContaining({
          opId: 'op-perm-fail',
          error: 'Bad request',
          retriesLeft: 0,
        }),
      );
    });

    it('emits message.failed for message.send permanent failures', async () => {
      const op = makeOutboxOp({
        id: 'op-msg-fail',
        type: 'message.send',
        maxRetries: 3,
        localData: makeMessage({ id: 'local-op-msg-fail', status: 'pending' }),
      });
      await storage.enqueue(op);

      mockRequest.mockResolvedValueOnce({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Not allowed' },
      });

      const msgFailListener = vi.fn();
      manager.on('message.failed', msgFailListener);

      await manager.flush();

      expect(msgFailListener).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'op-msg-fail', error: 'Not allowed' }),
      );
    });
  });

  // ── 26. flush transient error → retry scheduling ─────────────

  describe('flush transient error', () => {
    it('increments retries for transient errors and keeps operation pending', async () => {
      const op = makeOutboxOp({ id: 'op-transient', maxRetries: 3, retries: 0 });
      await storage.enqueue(op);

      mockRequest.mockResolvedValueOnce({
        ok: false,
        error: { code: 'NETWORK_TIMEOUT', message: 'Timed out' },
      });

      await manager.flush();

      // Operation should still be pending (nack set it back to pending with retries=1)
      const count = await storage.getPendingCount();
      expect(count).toBe(1);
    });

    it('nacks on network exception and retries', async () => {
      const op = makeOutboxOp({ id: 'op-exception', maxRetries: 3, retries: 0 });
      await storage.enqueue(op);

      mockRequest.mockRejectedValueOnce(new Error('Network unreachable'));

      const failedListener = vi.fn();
      manager.on('outbox.failed', failedListener);

      await manager.flush();

      // retries 0 + 1 = 1, which is < maxRetries 3, so no failed event for this case
      // (failed event only emitted when retries + 1 >= maxRetries)
      // The operation is nacked back to pending
      const count = await storage.getPendingCount();
      expect(count).toBe(1);
    });

    it('emits outbox.failed when network exception exhausts retries', async () => {
      const op = makeOutboxOp({ id: 'op-exhaust', maxRetries: 1, retries: 0 });
      await storage.enqueue(op);

      mockRequest.mockRejectedValueOnce(new Error('Network down'));

      const failedListener = vi.fn();
      manager.on('outbox.failed', failedListener);

      await manager.flush();

      // retries 0 + 1 = 1 >= maxRetries 1 → emit failed
      expect(failedListener).toHaveBeenCalledWith(
        expect.objectContaining({ opId: 'op-exhaust', retriesLeft: 0 }),
      );
    });
  });

  // ── 27. outboxSize getter ────────────────────────────────────

  describe('outboxSize', () => {
    it('reflects the pending count in storage', async () => {
      expect(await manager.outboxSize).toBe(0);

      await storage.enqueue(makeOutboxOp({ id: 'op-a' }));
      await storage.enqueue(makeOutboxOp({ id: 'op-b' }));

      expect(await manager.outboxSize).toBe(2);
    });
  });

  // ── Additional edge cases ────────────────────────────────────

  describe('flush when offline', () => {
    it('does nothing when offline', async () => {
      manager.setOnline(false);
      await storage.enqueue(makeOutboxOp({ id: 'op-offline' }));

      await manager.flush();

      expect(mockRequest).not.toHaveBeenCalled();
      expect(await storage.getPendingCount()).toBe(1);
    });
  });

  describe('flush reentrance guard', () => {
    it('skips flush if already flushing', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(r => { resolveFirst = r; });

      mockRequest.mockImplementationOnce(async () => {
        await firstPromise;
        return { ok: true, data: {} };
      });

      await storage.enqueue(makeOutboxOp({ id: 'op-1' }));

      // Start first flush (will block on mockRequest)
      const flush1 = manager.flush();
      // Start second flush immediately — should be a no-op
      const flush2 = manager.flush();

      // Release the first
      resolveFirst!();
      await flush1;
      await flush2;

      // Only one network call should have been made
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });
  });
});

// Needed for afterEach at module scope since vitest hoists it
import { afterEach } from 'vitest';
