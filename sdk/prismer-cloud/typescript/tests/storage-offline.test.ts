/**
 * Comprehensive tests for Prismer SDK v1.7 features:
 *   - MemoryStorage (StorageAdapter)
 *   - E2EEncryption
 *   - OfflineManager + outbox + sync
 *   - AttachmentQueue
 *   - TabCoordinator
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MemoryStorage,
  type StoredMessage,
  type StoredConversation,
  type StoredContact,
  type OutboxOperation,
} from '../src/storage';
import { E2EEncryption } from '../src/encryption';
import { OfflineManager, AttachmentQueue } from '../src/offline';
import { TabCoordinator } from '../src/multitab';
import type { RequestFn } from '../src/types';

// ============================================================================
// Helper factories
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
    unreadCount: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeContact(overrides: Partial<StoredContact> = {}): StoredContact {
  return {
    userId: `user-${Math.random().toString(36).slice(2, 8)}`,
    username: 'alice',
    displayName: 'Alice',
    role: 'agent',
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
    path: '/api/im/direct/conv-1',
    body: { content: 'hello' },
    status: 'pending',
    createdAt: Date.now(),
    retries: 0,
    maxRetries: 5,
    idempotencyKey: `key-${Date.now()}`,
    ...overrides,
  };
}

function mockRequestFn(responses: Record<string, any> = {}): RequestFn {
  return vi.fn(async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const key = `${method} ${path}`;
    if (responses[key]) return responses[key] as T;
    return { ok: true, data: {} } as T;
  }) as unknown as RequestFn;
}

// ============================================================================
// 1. MemoryStorage
// ============================================================================

describe('MemoryStorage', () => {
  let storage: MemoryStorage;

  beforeEach(async () => {
    storage = new MemoryStorage();
    await storage.init();
  });

  // ── Messages ──────────────────────────────────────────────

  describe('messages', () => {
    it('putMessages + getMessage', async () => {
      const msg = makeMessage({ id: 'msg-1' });
      await storage.putMessages([msg]);
      const stored = await storage.getMessage('msg-1');
      expect(stored).not.toBeNull();
      expect(stored!.id).toBe('msg-1');
      expect(stored!.content).toBe('Hello world');
    });

    it('getMessages filters by conversationId', async () => {
      await storage.putMessages([
        makeMessage({ id: 'm1', conversationId: 'conv-A', createdAt: '2024-01-01T00:00:00Z' }),
        makeMessage({ id: 'm2', conversationId: 'conv-B', createdAt: '2024-01-01T00:00:01Z' }),
        makeMessage({ id: 'm3', conversationId: 'conv-A', createdAt: '2024-01-01T00:00:02Z' }),
      ]);
      const msgs = await storage.getMessages('conv-A', { limit: 50 });
      expect(msgs).toHaveLength(2);
      expect(msgs.map(m => m.id)).toEqual(['m1', 'm3']);
    });

    it('getMessages respects limit', async () => {
      for (let i = 0; i < 10; i++) {
        await storage.putMessages([
          makeMessage({ id: `m${i}`, conversationId: 'c1', createdAt: `2024-01-01T00:00:${String(i).padStart(2, '0')}Z` }),
        ]);
      }
      const msgs = await storage.getMessages('c1', { limit: 3 });
      expect(msgs).toHaveLength(3);
      // Should return the last 3 (newest)
      expect(msgs.map(m => m.id)).toEqual(['m7', 'm8', 'm9']);
    });

    it('getMessages with before cursor', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.putMessages([
          makeMessage({ id: `m${i}`, conversationId: 'c1', createdAt: `2024-01-01T00:00:0${i}Z` }),
        ]);
      }
      const msgs = await storage.getMessages('c1', { limit: 2, before: 'm3' });
      expect(msgs).toHaveLength(2);
      expect(msgs.map(m => m.id)).toEqual(['m1', 'm2']);
    });

    it('deleteMessage removes a message', async () => {
      await storage.putMessages([makeMessage({ id: 'msg-del' })]);
      expect(await storage.getMessage('msg-del')).not.toBeNull();
      await storage.deleteMessage('msg-del');
      expect(await storage.getMessage('msg-del')).toBeNull();
    });

    it('putMessages upserts (overwrites same id)', async () => {
      await storage.putMessages([makeMessage({ id: 'dup', content: 'v1' })]);
      await storage.putMessages([makeMessage({ id: 'dup', content: 'v2' })]);
      const msg = await storage.getMessage('dup');
      expect(msg!.content).toBe('v2');
    });
  });

  // ── Conversations ─────────────────────────────────────────

  describe('conversations', () => {
    it('putConversations + getConversation', async () => {
      const conv = makeConversation({ id: 'conv-1', title: 'Test' });
      await storage.putConversations([conv]);
      const stored = await storage.getConversation('conv-1');
      expect(stored).not.toBeNull();
      expect(stored!.title).toBe('Test');
    });

    it('getConversations returns sorted by lastMessageAt desc', async () => {
      await storage.putConversations([
        makeConversation({ id: 'c1', lastMessageAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' }),
        makeConversation({ id: 'c3', lastMessageAt: '2024-01-03T00:00:00Z', updatedAt: '2024-01-03T00:00:00Z' }),
        makeConversation({ id: 'c2', lastMessageAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' }),
      ]);
      const convos = await storage.getConversations({ limit: 50 });
      expect(convos.map(c => c.id)).toEqual(['c3', 'c2', 'c1']);
    });

    it('getConversations respects limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.putConversations([
          makeConversation({ id: `c${i}`, lastMessageAt: `2024-01-0${i + 1}T00:00:00Z`, updatedAt: `2024-01-0${i + 1}T00:00:00Z` }),
        ]);
      }
      const page = await storage.getConversations({ limit: 2, offset: 1 });
      expect(page).toHaveLength(2);
      expect(page[0].id).toBe('c3'); // skip c4 (index 0), return c3, c2
    });

    it('getConversation returns null for unknown', async () => {
      expect(await storage.getConversation('nonexistent')).toBeNull();
    });
  });

  // ── Contacts ──────────────────────────────────────────────

  describe('contacts', () => {
    it('putContacts + getContacts', async () => {
      await storage.putContacts([
        makeContact({ userId: 'u1', username: 'alice' }),
        makeContact({ userId: 'u2', username: 'bob' }),
      ]);
      const contacts = await storage.getContacts();
      expect(contacts).toHaveLength(2);
    });

    it('putContacts upserts by userId', async () => {
      await storage.putContacts([makeContact({ userId: 'u1', displayName: 'Alice V1' })]);
      await storage.putContacts([makeContact({ userId: 'u1', displayName: 'Alice V2' })]);
      const contacts = await storage.getContacts();
      expect(contacts).toHaveLength(1);
      expect(contacts[0].displayName).toBe('Alice V2');
    });
  });

  // ── Cursors ───────────────────────────────────────────────

  describe('cursors', () => {
    it('getCursor returns null for unknown key', async () => {
      expect(await storage.getCursor('unknown')).toBeNull();
    });

    it('setCursor + getCursor', async () => {
      await storage.setCursor('sync_v1', '42');
      expect(await storage.getCursor('sync_v1')).toBe('42');
    });

    it('setCursor overwrites', async () => {
      await storage.setCursor('k', '1');
      await storage.setCursor('k', '2');
      expect(await storage.getCursor('k')).toBe('2');
    });
  });

  // ── Outbox ────────────────────────────────────────────────

  describe('outbox', () => {
    it('enqueue + dequeueReady', async () => {
      const op = makeOutboxOp({ id: 'op1' });
      await storage.enqueue(op);
      const ready = await storage.dequeueReady(10);
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe('op1');
      expect(ready[0].status).toBe('inflight');
    });

    it('dequeueReady respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.enqueue(makeOutboxOp({ id: `op${i}`, createdAt: Date.now() + i }));
      }
      const ready = await storage.dequeueReady(2);
      expect(ready).toHaveLength(2);
    });

    it('dequeueReady only returns pending ops', async () => {
      await storage.enqueue(makeOutboxOp({ id: 'op1', status: 'pending' }));
      await storage.enqueue(makeOutboxOp({ id: 'op2', status: 'failed' }));
      const ready = await storage.dequeueReady(10);
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe('op1');
    });

    it('ack removes operation from outbox', async () => {
      await storage.enqueue(makeOutboxOp({ id: 'op-ack' }));
      await storage.ack('op-ack');
      expect(await storage.getPendingCount()).toBe(0);
    });

    it('nack updates retries and status', async () => {
      await storage.enqueue(makeOutboxOp({ id: 'op-nack', maxRetries: 3 }));
      // Dequeue to make it inflight
      await storage.dequeueReady(1);
      // Nack with retries < max
      await storage.nack('op-nack', 'timeout', 1);
      const count = await storage.getPendingCount();
      expect(count).toBe(1); // Back to pending
    });

    it('nack marks as failed when retries exceed max', async () => {
      await storage.enqueue(makeOutboxOp({ id: 'op-fail', maxRetries: 2 }));
      await storage.dequeueReady(1);
      await storage.nack('op-fail', 'timeout', 2);
      const count = await storage.getPendingCount();
      expect(count).toBe(0); // Failed, not counted as pending
    });

    it('getPendingCount counts pending + inflight', async () => {
      await storage.enqueue(makeOutboxOp({ id: 'p1', status: 'pending' }));
      await storage.enqueue(makeOutboxOp({ id: 'p2', status: 'pending' }));
      expect(await storage.getPendingCount()).toBe(2);
      await storage.dequeueReady(1); // Moves one to inflight
      expect(await storage.getPendingCount()).toBe(2); // pending + inflight both count
    });
  });

  // ── Search ────────────────────────────────────────────────

  describe('searchMessages', () => {
    it('finds messages by content substring', async () => {
      await storage.putMessages([
        makeMessage({ id: 'm1', content: 'Hello Alice', conversationId: 'c1' }),
        makeMessage({ id: 'm2', content: 'Hello Bob', conversationId: 'c1' }),
        makeMessage({ id: 'm3', content: 'Goodbye Alice', conversationId: 'c1' }),
      ]);
      const results = await storage.searchMessages('alice');
      expect(results).toHaveLength(2);
    });

    it('case-insensitive search', async () => {
      await storage.putMessages([
        makeMessage({ id: 'm1', content: 'HELLO WORLD' }),
      ]);
      const results = await storage.searchMessages('hello');
      expect(results).toHaveLength(1);
    });

    it('filters by conversationId', async () => {
      await storage.putMessages([
        makeMessage({ id: 'm1', content: 'test', conversationId: 'c1' }),
        makeMessage({ id: 'm2', content: 'test', conversationId: 'c2' }),
      ]);
      const results = await storage.searchMessages('test', { conversationId: 'c1' });
      expect(results).toHaveLength(1);
      expect(results[0].conversationId).toBe('c1');
    });

    it('respects limit', async () => {
      for (let i = 0; i < 10; i++) {
        await storage.putMessages([makeMessage({ id: `m${i}`, content: 'match' })]);
      }
      const results = await storage.searchMessages('match', { limit: 3 });
      expect(results).toHaveLength(3);
    });
  });

  // ── Quota ─────────────────────────────────────────────────

  describe('quota', () => {
    it('getStorageSize returns approximate sizes', async () => {
      await storage.putMessages([makeMessage(), makeMessage()]);
      await storage.putConversations([makeConversation()]);
      const size = await storage.getStorageSize!();
      expect(size.messages).toBeGreaterThan(0);
      expect(size.conversations).toBeGreaterThan(0);
      expect(size.total).toBe(size.messages + size.conversations);
    });

    it('clearOldMessages keeps newest N messages', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.putMessages([
          makeMessage({ id: `m${i}`, conversationId: 'c1', createdAt: `2024-01-01T00:00:0${i}Z` }),
        ]);
      }
      const deleted = await storage.clearOldMessages!('c1', 2);
      expect(deleted).toBe(3);
      const remaining = await storage.getMessages('c1', { limit: 50 });
      expect(remaining).toHaveLength(2);
      expect(remaining.map(m => m.id)).toEqual(['m3', 'm4']); // newest 2
    });
  });

  // ── Lifecycle ─────────────────────────────────────────────

  describe('clear', () => {
    it('clears all data', async () => {
      await storage.putMessages([makeMessage()]);
      await storage.putConversations([makeConversation()]);
      await storage.putContacts([makeContact()]);
      await storage.setCursor('k', 'v');
      await storage.enqueue(makeOutboxOp());

      await storage.clear();

      expect(await storage.getMessages('conv-1', { limit: 50 })).toHaveLength(0);
      expect(await storage.getConversations()).toHaveLength(0);
      expect(await storage.getContacts()).toHaveLength(0);
      expect(await storage.getCursor('k')).toBeNull();
      expect(await storage.getPendingCount()).toBe(0);
    });
  });
});

// ============================================================================
// 2. E2EEncryption
// ============================================================================

describe('E2EEncryption', () => {
  let e2e: E2EEncryption;

  beforeEach(async () => {
    e2e = new E2EEncryption();
    await e2e.init('test-passphrase');
  });

  afterEach(() => {
    e2e.destroy();
  });

  it('init does not throw', async () => {
    const enc = new E2EEncryption();
    await expect(enc.init('password')).resolves.not.toThrow();
    enc.destroy();
  });

  it('exportPublicKey returns JWK', async () => {
    const pubKey = await e2e.exportPublicKey();
    expect(pubKey.kty).toBe('EC');
    expect(pubKey.crv).toBe('P-256');
    expect(pubKey.x).toBeDefined();
    expect(pubKey.y).toBeDefined();
  });

  it('exportPublicKey throws if not initialized', async () => {
    const enc = new E2EEncryption();
    await expect(enc.exportPublicKey()).rejects.toThrow('not initialized');
  });

  it('generateSessionKey + encrypt + decrypt round-trip', async () => {
    await e2e.generateSessionKey('conv-1');
    const plaintext = 'Hello, encrypted world!';
    const ciphertext = await e2e.encrypt('conv-1', plaintext);

    expect(ciphertext).not.toBe(plaintext);
    expect(typeof ciphertext).toBe('string');

    const decrypted = await e2e.decrypt('conv-1', ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypt throws without session key', async () => {
    await expect(e2e.encrypt('no-key-conv', 'hello')).rejects.toThrow('No session key');
  });

  it('decrypt throws without session key', async () => {
    await expect(e2e.decrypt('no-key-conv', 'data')).rejects.toThrow('No session key');
  });

  it('different conversations have different keys', async () => {
    await e2e.generateSessionKey('conv-A');
    await e2e.generateSessionKey('conv-B');

    const ct1 = await e2e.encrypt('conv-A', 'same message');
    const ct2 = await e2e.encrypt('conv-B', 'same message');

    // Ciphertexts should be different (different keys + IVs)
    expect(ct1).not.toBe(ct2);
  });

  it('ECDH key exchange: two parties derive same session key', async () => {
    const alice = new E2EEncryption();
    const bob = new E2EEncryption();
    await alice.init('alice-pass');
    await bob.init('bob-pass');

    const alicePub = await alice.exportPublicKey();
    const bobPub = await bob.exportPublicKey();

    await alice.deriveSessionKey('conv-shared', bobPub);
    await bob.deriveSessionKey('conv-shared', alicePub);

    // Alice encrypts, Bob decrypts
    const ciphertext = await alice.encrypt('conv-shared', 'Secret message');
    const decrypted = await bob.decrypt('conv-shared', ciphertext);
    expect(decrypted).toBe('Secret message');

    // Bob encrypts, Alice decrypts
    const ct2 = await bob.encrypt('conv-shared', 'Reply from Bob');
    const dec2 = await alice.decrypt('conv-shared', ct2);
    expect(dec2).toBe('Reply from Bob');

    alice.destroy();
    bob.destroy();
  });

  it('setSessionKey with raw key', async () => {
    // Generate a key on one instance
    const rawKey = await e2e.generateSessionKey('conv-1');
    expect(rawKey).toBeInstanceOf(ArrayBuffer);

    const ct = await e2e.encrypt('conv-1', 'test message');

    // Import same raw key on another instance
    const e2e2 = new E2EEncryption();
    await e2e2.init('other-pass');
    await e2e2.setSessionKey('conv-1', rawKey);

    const decrypted = await e2e2.decrypt('conv-1', ct);
    expect(decrypted).toBe('test message');
    e2e2.destroy();
  });

  it('hasSessionKey / removeSessionKey', async () => {
    expect(e2e.hasSessionKey('conv-x')).toBe(false);
    await e2e.generateSessionKey('conv-x');
    expect(e2e.hasSessionKey('conv-x')).toBe(true);
    e2e.removeSessionKey('conv-x');
    expect(e2e.hasSessionKey('conv-x')).toBe(false);
  });

  it('destroy clears all state', async () => {
    await e2e.generateSessionKey('conv-1');
    e2e.destroy();
    // After destroy, exportPublicKey should fail
    await expect(e2e.exportPublicKey()).rejects.toThrow();
  });

  it('encrypt produces different ciphertext each time (random IV)', async () => {
    await e2e.generateSessionKey('conv-1');
    const ct1 = await e2e.encrypt('conv-1', 'same');
    const ct2 = await e2e.encrypt('conv-1', 'same');
    expect(ct1).not.toBe(ct2);
  });

  it('handles empty string', async () => {
    await e2e.generateSessionKey('conv-1');
    const ct = await e2e.encrypt('conv-1', '');
    const pt = await e2e.decrypt('conv-1', ct);
    expect(pt).toBe('');
  });

  it('handles unicode content', async () => {
    await e2e.generateSessionKey('conv-1');
    const unicode = '你好世界 🌍 مرحبا';
    const ct = await e2e.encrypt('conv-1', unicode);
    const pt = await e2e.decrypt('conv-1', ct);
    expect(pt).toBe(unicode);
  });

  it('handles long content', async () => {
    await e2e.generateSessionKey('conv-1');
    const longText = 'x'.repeat(100_000);
    const ct = await e2e.encrypt('conv-1', longText);
    const pt = await e2e.decrypt('conv-1', ct);
    expect(pt).toBe(longText);
  });
});

// ============================================================================
// 3. OfflineManager
// ============================================================================

describe('OfflineManager', () => {
  let storage: MemoryStorage;
  let requestFn: ReturnType<typeof vi.fn>;
  let offline: OfflineManager;

  beforeEach(async () => {
    storage = new MemoryStorage();
    requestFn = vi.fn(async () => ({ ok: true, data: {} }));
    offline = new OfflineManager(
      storage,
      requestFn as unknown as RequestFn,
      {
        syncOnConnect: false,
        outboxFlushInterval: 100_000, // Disable auto-flush in tests
      },
    );
    await offline.init();
  });

  afterEach(async () => {
    await offline.destroy();
  });

  describe('network state', () => {
    it('starts online by default', () => {
      expect(offline.isOnline).toBe(true);
    });

    it('setOnline toggles state', () => {
      offline.setOnline(false);
      expect(offline.isOnline).toBe(false);
      offline.setOnline(true);
      expect(offline.isOnline).toBe(true);
    });

    it('emits network.offline and network.online events', () => {
      const events: string[] = [];
      offline.on('network.offline', () => events.push('offline'));
      offline.on('network.online', () => events.push('online'));

      offline.setOnline(false);
      offline.setOnline(true);

      expect(events).toEqual(['offline', 'online']);
    });

    it('does not emit duplicate events for same state', () => {
      const events: string[] = [];
      offline.on('network.offline', () => events.push('offline'));
      offline.on('network.online', () => events.push('online'));

      offline.setOnline(true); // Already online, no event
      offline.setOnline(true); // Still no event
      expect(events).toEqual([]);
    });
  });

  describe('dispatch — write operations', () => {
    it('message.send goes through outbox', async () => {
      const result = await offline.dispatch<any>(
        'POST', '/api/im/direct/conv-1',
        { content: 'hello', type: 'text' },
      );

      expect(result.ok).toBe(true);
      expect(result._pending).toBe(true);
      expect(result._clientId).toBeDefined();

      // Local message created in storage
      const msgs = await storage.getMessages('conv-1', { limit: 10 });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].status).toBe('pending');
      expect(msgs[0].content).toBe('hello');
    });

    it('message.edit recognized as write op', async () => {
      const result = await offline.dispatch<any>(
        'PATCH', '/api/im/messages/msg-1',
        { content: 'edited' },
      );
      expect(result.ok).toBe(true);
      expect(result._pending).toBe(true);
    });

    it('message.delete recognized as write op', async () => {
      const result = await offline.dispatch<any>('DELETE', '/api/im/messages/msg-1');
      expect(result.ok).toBe(true);
      expect(result._pending).toBe(true);
    });

    it('emits message.local event', async () => {
      let localMsg: StoredMessage | undefined;
      offline.on('message.local', (msg) => { localMsg = msg; });

      await offline.dispatch('POST', '/api/im/direct/conv-1', { content: 'hi' });

      expect(localMsg).toBeDefined();
      expect(localMsg!.content).toBe('hi');
      expect(localMsg!.status).toBe('pending');
    });
  });

  describe('dispatch — read operations', () => {
    it('GET passes through to network', async () => {
      requestFn.mockResolvedValueOnce({ ok: true, data: [{ id: 'conv-1' }] });

      const result = await offline.dispatch('GET', '/api/im/something');
      expect(requestFn).toHaveBeenCalledWith('GET', '/api/im/something', undefined, undefined);
      expect(result).toEqual({ ok: true, data: [{ id: 'conv-1' }] });
    });

    it('GET returns cached data when available', async () => {
      // Pre-populate cache
      await storage.putConversations([makeConversation({ id: 'conv-1' })]);

      const result = await offline.dispatch<any>('GET', '/api/im/conversations');
      // Should return from cache without network call
      expect(result.ok).toBe(true);
      expect(result.data).toHaveLength(1);
    });

    it('GET returns empty when offline with no cache', async () => {
      offline.setOnline(false);
      requestFn.mockRejectedValueOnce(new Error('offline'));

      const result = await offline.dispatch<any>('GET', '/api/im/something-random');
      expect(result.ok).toBe(true);
    });
  });

  describe('flush', () => {
    it('sends queued operations when online', async () => {
      // Go offline so dispatch doesn't trigger implicit flush
      offline.setOnline(false);
      await offline.dispatch('POST', '/api/im/direct/conv-1', { content: 'hello' });

      requestFn.mockResolvedValueOnce({
        ok: true,
        data: { conversationId: 'conv-1', message: { id: 'srv-1', content: 'hello', conversationId: 'conv-1', senderId: 'u1', createdAt: new Date().toISOString() } },
      });

      // Set online without triggering implicit flush
      (offline as any)._isOnline = true;
      await offline.flush();

      expect(requestFn).toHaveBeenCalled();
    });

    it('emits outbox.confirmed on success', async () => {
      offline.setOnline(false);
      await offline.dispatch('POST', '/api/im/direct/conv-1', { content: 'hello' });

      requestFn.mockResolvedValueOnce({
        ok: true,
        data: { conversationId: 'conv-1', message: { id: 'srv-1', content: 'hello' } },
      });

      let confirmed = false;
      offline.on('outbox.confirmed', () => { confirmed = true; });

      (offline as any)._isOnline = true;
      await offline.flush();

      expect(confirmed).toBe(true);
    });

    it('emits outbox.failed on permanent error', async () => {
      offline.setOnline(false);
      await offline.dispatch('POST', '/api/im/direct/conv-1', { content: 'bad' });

      requestFn.mockResolvedValueOnce({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Bad content' },
      });

      let failEvent: any;
      offline.on('outbox.failed', (e) => { failEvent = e; });

      (offline as any)._isOnline = true;
      await offline.flush();

      expect(failEvent).toBeDefined();
      expect(failEvent.retriesLeft).toBe(0);
    });

    it('does not flush when offline', async () => {
      offline.setOnline(false);
      await offline.dispatch('POST', '/api/im/direct/conv-1', { content: 'hello' });
      await offline.flush();
      expect(requestFn).not.toHaveBeenCalled();
    });

    it('retries on transient network error', async () => {
      offline.setOnline(false);
      await offline.dispatch('POST', '/api/im/direct/conv-1', { content: 'retry' });

      let callCount = 0;
      requestFn.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('Network error');
        return { ok: true, data: { message: { id: 'srv-1' } } };
      });

      (offline as any)._isOnline = true;
      await offline.flush(); // First attempt fails
      await offline.flush(); // Second attempt succeeds

      expect(callCount).toBe(2);
    });
  });

  describe('sync', () => {
    it('fetches events and applies them', async () => {
      requestFn.mockResolvedValueOnce({
        ok: true,
        data: {
          events: [
            {
              seq: 1,
              type: 'message.new',
              data: { id: 'msg-from-sync', content: 'synced', conversationId: 'conv-1', senderId: 'u2', createdAt: '2024-01-01T00:00:00Z' },
              at: '2024-01-01T00:00:00Z',
            },
          ],
          cursor: 1,
          hasMore: false,
        },
      });

      await offline.sync();

      const msg = await storage.getMessage('msg-from-sync');
      expect(msg).not.toBeNull();
      expect(msg!.content).toBe('synced');
      expect(msg!.status).toBe('confirmed');
    });

    it('emits sync.start and sync.complete', async () => {
      requestFn.mockResolvedValueOnce({
        ok: true,
        data: { events: [], cursor: 0, hasMore: false },
      });

      const events: string[] = [];
      offline.on('sync.start', () => events.push('start'));
      offline.on('sync.complete', () => events.push('complete'));

      await offline.sync();

      expect(events).toEqual(['start', 'complete']);
    });

    it('emits sync.error on failure', async () => {
      requestFn.mockResolvedValueOnce({
        ok: false,
        error: { code: 'SERVER_ERROR', message: 'Internal error' },
      });

      let errEvent: any;
      offline.on('sync.error', (e) => { errEvent = e; });

      await offline.sync();

      expect(errEvent).toBeDefined();
      expect(errEvent.error).toContain('Internal error');
    });

    it('updates sync cursor', async () => {
      requestFn.mockResolvedValueOnce({
        ok: true,
        data: { events: [{ seq: 42, type: 'message.new', data: { id: 'm1', content: 'x' }, at: '2024-01-01T00:00:00Z' }], cursor: 42, hasMore: false },
      });

      await offline.sync();
      expect(await storage.getCursor('global_sync')).toBe('42');
    });

    it('handles message.delete sync events', async () => {
      await storage.putMessages([makeMessage({ id: 'msg-del' })]);

      requestFn.mockResolvedValueOnce({
        ok: true,
        data: {
          events: [{ seq: 1, type: 'message.delete', data: { id: 'msg-del' }, at: '2024-01-01T00:00:00Z' }],
          cursor: 1,
          hasMore: false,
        },
      });

      await offline.sync();
      expect(await storage.getMessage('msg-del')).toBeNull();
    });

    it('handles conversation.create sync events', async () => {
      requestFn.mockResolvedValueOnce({
        ok: true,
        data: {
          events: [{
            seq: 1,
            type: 'conversation.create',
            data: { id: 'conv-new', type: 'group', title: 'New Group' },
            at: '2024-01-01T00:00:00Z',
          }],
          cursor: 1,
          hasMore: false,
        },
      });

      await offline.sync();
      const conv = await storage.getConversation('conv-new');
      expect(conv).not.toBeNull();
      expect(conv!.title).toBe('New Group');
    });

    it('does not sync when already syncing', async () => {
      let syncCallCount = 0;
      requestFn.mockImplementation(async () => {
        syncCallCount++;
        await new Promise(r => setTimeout(r, 50));
        return { ok: true, data: { events: [], cursor: 0, hasMore: false } };
      });

      // Start two syncs concurrently
      const p1 = offline.sync();
      const p2 = offline.sync(); // Should be no-op

      await Promise.all([p1, p2]);
      expect(syncCallCount).toBe(1);
    });
  });

  describe('handleRealtimeEvent', () => {
    it('stores new messages from realtime', async () => {
      await offline.handleRealtimeEvent('message.new', {
        id: 'rt-msg-1',
        conversationId: 'conv-1',
        content: 'Realtime message',
        senderId: 'u2',
        type: 'text',
        createdAt: '2024-01-01T00:00:00Z',
      });

      const msg = await storage.getMessage('rt-msg-1');
      expect(msg).not.toBeNull();
      expect(msg!.content).toBe('Realtime message');
      expect(msg!.status).toBe('confirmed');
    });

    it('tracks presence changes', async () => {
      await offline.handleRealtimeEvent('presence.changed', {
        userId: 'u1',
        status: 'online',
        lastSeen: '2024-01-01T00:00:00Z',
      });

      const presence = offline.getPresence('u1');
      expect(presence).not.toBeNull();
      expect(presence!.status).toBe('online');
    });
  });

  describe('searchMessages', () => {
    it('delegates to storage.searchMessages', async () => {
      await storage.putMessages([
        makeMessage({ id: 'm1', content: 'find me', conversationId: 'c1' }),
        makeMessage({ id: 'm2', content: 'not this', conversationId: 'c1' }),
      ]);

      const results = await offline.searchMessages('find');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('m1');
    });
  });

  describe('quota', () => {
    it('getQuotaStatus returns quota info', async () => {
      const quota = await offline.getQuotaStatus();
      expect(quota.limit).toBeGreaterThan(0);
      expect(quota.percentage).toBeGreaterThanOrEqual(0);
      expect(typeof quota.warning).toBe('boolean');
      expect(typeof quota.exceeded).toBe('boolean');
    });
  });

  describe('event emitter', () => {
    it('on/off removes listener', () => {
      const cb = vi.fn();
      offline.on('network.online', cb);
      offline.off('network.online', cb);

      offline.setOnline(false);
      offline.setOnline(true);

      expect(cb).not.toHaveBeenCalled();
    });

    it('listener errors do not crash', () => {
      offline.on('network.online', () => { throw new Error('boom'); });
      // Should not throw
      expect(() => offline.setOnline(false)).not.toThrow();
      expect(() => offline.setOnline(true)).not.toThrow();
    });
  });
});

// ============================================================================
// 4. AttachmentQueue
// ============================================================================

describe('AttachmentQueue', () => {
  let storage: MemoryStorage;
  let requestFn: ReturnType<typeof vi.fn>;
  let offline: OfflineManager;
  let queue: AttachmentQueue;

  beforeEach(async () => {
    storage = new MemoryStorage();
    requestFn = vi.fn(async () => ({ ok: true, data: {} }));
    offline = new OfflineManager(
      storage,
      requestFn as unknown as RequestFn,
      { syncOnConnect: false, outboxFlushInterval: 100_000 },
    );
    await offline.init();
    queue = new AttachmentQueue(offline, requestFn as unknown as RequestFn);
  });

  afterEach(async () => {
    await offline.destroy();
  });

  it('queueAttachment creates local message and returns attachment', async () => {
    // Go offline so processQueue doesn't fire immediately
    offline.setOnline(false);

    const data = new ArrayBuffer(100);
    const att = await queue.queueAttachment('conv-1', {
      name: 'doc.pdf',
      size: 100,
      type: 'application/pdf',
      data,
    });

    expect(att.id).toBeDefined();
    expect(att.status).toBe('pending');
    expect(att.file.name).toBe('doc.pdf');

    // Check local message was created
    const msgs = await storage.getMessages('conv-1', { limit: 10 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('file');
    expect(msgs[0].status).toBe('pending');
  });

  it('getQueue returns queued attachments', async () => {
    const data = new ArrayBuffer(10);
    await queue.queueAttachment('conv-1', { name: 'a.txt', size: 10, type: 'text/plain', data });
    await queue.queueAttachment('conv-1', { name: 'b.txt', size: 10, type: 'text/plain', data });

    const items = queue.getQueue();
    expect(items).toHaveLength(2);
  });

  it('cancel removes attachment and local message', async () => {
    const data = new ArrayBuffer(10);
    const att = await queue.queueAttachment('conv-1', { name: 'cancel.txt', size: 10, type: 'text/plain', data });

    await queue.cancel(att.id);

    expect(queue.getQueue()).toHaveLength(0);
    const msgs = await storage.getMessages('conv-1', { limit: 10 });
    expect(msgs).toHaveLength(0);
  });

  it('retry resets failed attachment to pending', async () => {
    const data = new ArrayBuffer(10);
    const att = await queue.queueAttachment('conv-1', { name: 'retry.txt', size: 10, type: 'text/plain', data });

    // Simulate failure
    const items = queue.getQueue();
    items[0].status = 'failed';
    items[0].error = 'network error';

    await queue.retry(att.id);

    const updated = queue.getQueue();
    expect(updated[0].status).toBe('pending');
    expect(updated[0].error).toBeUndefined();
  });

  it('processQueue uploads when online', async () => {
    // Go offline to prevent immediate processing
    offline.setOnline(false);

    let callCount = 0;
    requestFn.mockImplementation(async (_m: string, path: string) => {
      callCount++;
      if (path.includes('presign')) {
        return { ok: true, data: { uploadUrl: 'https://s3.example.com/upload', uploadId: 'u1', downloadUrl: 'https://s3.example.com/file' } };
      }
      if (path.includes('confirm')) {
        return { ok: true, data: { url: 'https://s3.example.com/file' } };
      }
      return { ok: true, data: {} };
    });

    // Mock fetch for the upload step
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('OK', { status: 200 })) as any;

    try {
      const data = new ArrayBuffer(10);
      await queue.queueAttachment('conv-1', { name: 'up.txt', size: 10, type: 'text/plain', data });

      // Now go online and process
      offline.setOnline(true);
      await queue.processQueue();

      // Should have called: presign, confirm, messages
      expect(callCount).toBeGreaterThanOrEqual(3);
      // Queue should be empty after successful upload
      expect(queue.getQueue()).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('processQueue handles upload failure', async () => {
    // Go offline to prevent immediate processing
    offline.setOnline(false);

    requestFn.mockImplementation(async (_m: string, path: string) => {
      if (path.includes('presign')) {
        return { ok: false, error: { code: 'FORBIDDEN', message: 'Not allowed' } };
      }
      return { ok: true, data: {} };
    });

    const data = new ArrayBuffer(10);
    await queue.queueAttachment('conv-1', { name: 'fail.txt', size: 10, type: 'text/plain', data });

    // Go online and process
    offline.setOnline(true);
    await queue.processQueue();

    const items = queue.getQueue();
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('failed');
    expect(items[0].error).toContain('Not allowed');
  });

  it('does not process when offline', async () => {
    offline.setOnline(false);
    const data = new ArrayBuffer(10);
    await queue.queueAttachment('conv-1', { name: 'off.txt', size: 10, type: 'text/plain', data });
    await queue.processQueue();

    // Request should not have been called (only the initial dispatch might)
    expect(queue.getQueue()).toHaveLength(1);
    expect(queue.getQueue()[0].status).toBe('pending');
  });
});

// ============================================================================
// 5. TabCoordinator
// ============================================================================

describe('TabCoordinator', () => {
  // We can't test BroadcastChannel in Node.js (it's browser-only),
  // so TabCoordinator falls back to single-tab mode (always leader).

  let storage: MemoryStorage;
  let requestFn: ReturnType<typeof vi.fn>;
  let offline: OfflineManager;

  beforeEach(async () => {
    storage = new MemoryStorage();
    requestFn = vi.fn(async () => ({ ok: true, data: {} }));
    offline = new OfflineManager(
      storage,
      requestFn as unknown as RequestFn,
      { syncOnConnect: false, outboxFlushInterval: 100_000 },
    );
    await offline.init();
  });

  afterEach(async () => {
    await offline.destroy();
  });

  it('becomes leader immediately in Node.js (no BroadcastChannel)', () => {
    const tab = new TabCoordinator(offline);
    tab.init();
    expect(tab.isLeader).toBe(true);
    tab.destroy();
  });

  it('destroy sets isLeader to false', () => {
    const tab = new TabCoordinator(offline);
    tab.init();
    expect(tab.isLeader).toBe(true);
    tab.destroy();
    expect(tab.isLeader).toBe(false);
  });

  it('relaySyncEvent does not throw in Node.js', () => {
    const tab = new TabCoordinator(offline);
    tab.init();
    // Should not throw even without BroadcastChannel
    expect(() => tab.relaySyncEvent({
      seq: 1,
      type: 'message.new',
      data: { id: 'm1' },
      at: new Date().toISOString(),
    })).not.toThrow();
    tab.destroy();
  });

  it('multiple coordinators in same process all become leader (no channel)', () => {
    const tab1 = new TabCoordinator(offline);
    const tab2 = new TabCoordinator(offline);
    tab1.init();
    tab2.init();
    // Both are leaders since there's no BroadcastChannel to coordinate
    expect(tab1.isLeader).toBe(true);
    expect(tab2.isLeader).toBe(true);
    tab1.destroy();
    tab2.destroy();
  });

  // Test with mock BroadcastChannel
  describe('with mock BroadcastChannel', () => {
    let channels: Map<string, Set<(e: MessageEvent) => void>>;
    let originalBC: typeof BroadcastChannel | undefined;

    beforeEach(() => {
      channels = new Map();
      originalBC = (globalThis as any).BroadcastChannel;

      // Mock BroadcastChannel
      (globalThis as any).BroadcastChannel = class MockBroadcastChannel {
        private name: string;
        onmessage: ((e: MessageEvent) => void) | null = null;

        constructor(name: string) {
          this.name = name;
          if (!channels.has(name)) channels.set(name, new Set());
          const listeners = channels.get(name)!;
          // Register this instance's message handler
          const handler = (e: MessageEvent) => this.onmessage?.(e);
          listeners.add(handler);
          (this as any)._handler = handler;
        }

        postMessage(data: any) {
          const listeners = channels.get(this.name);
          if (listeners) {
            for (const listener of listeners) {
              if (listener !== (this as any)._handler) {
                // Send to other instances only
                listener(new MessageEvent('message', { data }));
              }
            }
          }
        }

        close() {
          const listeners = channels.get(this.name);
          listeners?.delete((this as any)._handler);
        }
      };
    });

    afterEach(() => {
      if (originalBC !== undefined) {
        (globalThis as any).BroadcastChannel = originalBC;
      } else {
        delete (globalThis as any).BroadcastChannel;
      }
    });

    it('last-login-wins: second tab takes leadership from first', () => {
      const tab1 = new TabCoordinator(offline, 'test-channel');
      const tab2 = new TabCoordinator(offline, 'test-channel');

      tab1.init();
      expect(tab1.isLeader).toBe(true);

      tab2.init(); // Claims leadership
      expect(tab2.isLeader).toBe(true);
      expect(tab1.isLeader).toBe(false); // Demoted

      tab1.destroy();
      tab2.destroy();
    });

    it('tab.release allows another tab to claim leadership', () => {
      const tab1 = new TabCoordinator(offline, 'test-channel');
      const tab2 = new TabCoordinator(offline, 'test-channel');

      tab1.init();
      tab2.init();

      // tab2 is leader (last login wins)
      expect(tab2.isLeader).toBe(true);
      expect(tab1.isLeader).toBe(false);

      // tab2 releases
      tab2.destroy();
      // tab1 should claim leadership on release
      expect(tab1.isLeader).toBe(true);

      tab1.destroy();
    });
  });
});
