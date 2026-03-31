/**
 * Prismer SDK — Storage adapters for offline-first IM.
 *
 * Three built-in implementations:
 *   - MemoryStorage   — in-process Map, for tests / stateless agents
 *   - IndexedDBStorage — browser-persistent, for web apps
 *   - (future) SQLiteStorage — Node.js / React Native
 */

// ============================================================================
// Stored Data Models
// ============================================================================

export interface StoredMessage {
  id: string;
  clientId?: string;
  conversationId: string;
  content: string;
  type: string;
  senderId: string;
  parentId?: string | null;
  status: 'pending' | 'sent' | 'confirmed' | 'failed';
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt?: string;
  syncSeq?: number;
}

export interface StoredConversation {
  id: string;
  type: 'direct' | 'group';
  title?: string;
  lastMessage?: StoredMessage;
  lastMessageAt?: string;
  unreadCount: number;
  lastReadMessageId?: string;
  members?: Array<{ userId: string; username: string; displayName?: string; role: string }>;
  metadata?: Record<string, any>;
  syncSeq?: number;
  updatedAt: string;
}

export interface StoredContact {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  conversationId: string;
  lastMessageAt?: string;
  unreadCount: number;
  syncSeq?: number;
}

export interface OutboxOperation {
  id: string;
  type: 'message.send' | 'message.edit' | 'message.delete' | 'conversation.read';
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  status: 'pending' | 'inflight' | 'confirmed' | 'failed';
  createdAt: number;
  retries: number;
  maxRetries: number;
  lastError?: string;
  idempotencyKey: string;
  /** Local data for optimistic UI (e.g., the pending message) */
  localData?: unknown;
}

// ============================================================================
// Storage Adapter Interface
// ============================================================================

export interface StorageAdapter {
  /** Initialize the storage (open DB, create tables, etc.) */
  init(): Promise<void>;

  // ── Messages ────────────────────────────────────────────────
  putMessages(messages: StoredMessage[]): Promise<void>;
  getMessages(conversationId: string, opts: { limit: number; before?: string }): Promise<StoredMessage[]>;
  getMessage(messageId: string): Promise<StoredMessage | null>;
  deleteMessage(messageId: string): Promise<void>;

  // ── Conversations ───────────────────────────────────────────
  putConversations(conversations: StoredConversation[]): Promise<void>;
  getConversations(opts?: { limit: number; offset?: number }): Promise<StoredConversation[]>;
  getConversation(id: string): Promise<StoredConversation | null>;

  // ── Contacts ────────────────────────────────────────────────
  putContacts(contacts: StoredContact[]): Promise<void>;
  getContacts(): Promise<StoredContact[]>;

  // ── Sync cursors ────────────────────────────────────────────
  getCursor(key: string): Promise<string | null>;
  setCursor(key: string, value: string): Promise<void>;

  // ── Outbox ──────────────────────────────────────────────────
  enqueue(op: OutboxOperation): Promise<void>;
  dequeueReady(limit: number): Promise<OutboxOperation[]>;
  ack(opId: string): Promise<void>;
  nack(opId: string, error: string, retries: number): Promise<void>;
  getPendingCount(): Promise<number>;

  // ── Lifecycle ───────────────────────────────────────────────
  clear(): Promise<void>;

  // ── Search (optional) ─────────────────────────────────────
  /** Full-text search over message content. SQLiteStorage uses FTS5; others use basic contains. */
  searchMessages?(query: string, opts?: { conversationId?: string; limit?: number }): Promise<StoredMessage[]>;

  // ── Quota (optional) ──────────────────────────────────────
  /** Approximate storage size in bytes by category. */
  getStorageSize?(): Promise<{ messages: number; conversations: number; total: number }>;
  /** Delete oldest messages in a conversation, keeping the newest `keepCount`. Returns deleted count. */
  clearOldMessages?(conversationId: string, keepCount: number): Promise<number>;
}

// ============================================================================
// MemoryStorage — in-process Maps, no persistence
// ============================================================================

export class MemoryStorage implements StorageAdapter {
  private messages = new Map<string, StoredMessage>();
  private conversations = new Map<string, StoredConversation>();
  private contacts = new Map<string, StoredContact>();
  private cursors = new Map<string, string>();
  private outbox = new Map<string, OutboxOperation>();

  async init(): Promise<void> { /* no-op */ }

  // ── Messages ────────────────────────────────────────────────

  async putMessages(messages: StoredMessage[]): Promise<void> {
    for (const m of messages) this.messages.set(m.id, { ...m });
  }

  async getMessages(conversationId: string, opts: { limit: number; before?: string }): Promise<StoredMessage[]> {
    const all = Array.from(this.messages.values())
      .filter(m => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (opts.before) {
      const idx = all.findIndex(m => m.id === opts.before);
      if (idx > 0) return all.slice(Math.max(0, idx - opts.limit), idx);
    }
    return all.slice(-opts.limit);
  }

  async getMessage(messageId: string): Promise<StoredMessage | null> {
    return this.messages.get(messageId) ?? null;
  }

  async deleteMessage(messageId: string): Promise<void> {
    this.messages.delete(messageId);
  }

  // ── Conversations ───────────────────────────────────────────

  async putConversations(conversations: StoredConversation[]): Promise<void> {
    for (const c of conversations) this.conversations.set(c.id, { ...c });
  }

  async getConversations(opts?: { limit: number; offset?: number }): Promise<StoredConversation[]> {
    const all = Array.from(this.conversations.values())
      .sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt));
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return all.slice(offset, offset + limit);
  }

  async getConversation(id: string): Promise<StoredConversation | null> {
    return this.conversations.get(id) ?? null;
  }

  // ── Contacts ────────────────────────────────────────────────

  async putContacts(contacts: StoredContact[]): Promise<void> {
    for (const c of contacts) this.contacts.set(c.userId, { ...c });
  }

  async getContacts(): Promise<StoredContact[]> {
    return Array.from(this.contacts.values());
  }

  // ── Cursors ─────────────────────────────────────────────────

  async getCursor(key: string): Promise<string | null> {
    return this.cursors.get(key) ?? null;
  }

  async setCursor(key: string, value: string): Promise<void> {
    this.cursors.set(key, value);
  }

  // ── Outbox ──────────────────────────────────────────────────

  async enqueue(op: OutboxOperation): Promise<void> {
    this.outbox.set(op.id, { ...op });
  }

  async dequeueReady(limit: number): Promise<OutboxOperation[]> {
    const ready = Array.from(this.outbox.values())
      .filter(op => op.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);

    // Mark as inflight
    for (const op of ready) {
      op.status = 'inflight';
      this.outbox.set(op.id, op);
    }
    return ready;
  }

  async ack(opId: string): Promise<void> {
    this.outbox.delete(opId);
  }

  async nack(opId: string, error: string, retries: number): Promise<void> {
    const op = this.outbox.get(opId);
    if (!op) return;
    op.retries = retries;
    op.lastError = error;
    op.status = retries >= op.maxRetries ? 'failed' : 'pending';
    this.outbox.set(opId, op);
  }

  async getPendingCount(): Promise<number> {
    return Array.from(this.outbox.values()).filter(op => op.status === 'pending' || op.status === 'inflight').length;
  }

  // ── Search ─────────────────────────────────────────────────

  async searchMessages(query: string, opts?: { conversationId?: string; limit?: number }): Promise<StoredMessage[]> {
    const lower = query.toLowerCase();
    const limit = opts?.limit ?? 50;
    return Array.from(this.messages.values())
      .filter(m => {
        if (opts?.conversationId && m.conversationId !== opts.conversationId) return false;
        return (m.content ?? '').toLowerCase().includes(lower);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  // ── Quota ─────────────────────────────────────────────────

  async getStorageSize(): Promise<{ messages: number; conversations: number; total: number }> {
    const msgSize = this.messages.size * 500; // rough estimate ~500 bytes per message
    const convSize = this.conversations.size * 200;
    return { messages: msgSize, conversations: convSize, total: msgSize + convSize };
  }

  async clearOldMessages(conversationId: string, keepCount: number): Promise<number> {
    const msgs = Array.from(this.messages.values())
      .filter(m => m.conversationId === conversationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const toDelete = msgs.slice(keepCount);
    for (const m of toDelete) this.messages.delete(m.id);
    return toDelete.length;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async clear(): Promise<void> {
    this.messages.clear();
    this.conversations.clear();
    this.contacts.clear();
    this.cursors.clear();
    this.outbox.clear();
  }
}

// ============================================================================
// IndexedDBStorage — browser-persistent
// ============================================================================

const IDB_STORES = ['messages', 'conversations', 'contacts', 'cursors', 'outbox'] as const;

export class IndexedDBStorage implements StorageAdapter {
  private db: IDBDatabase | null = null;

  constructor(private dbName: string = 'prismer-offline', private version: number = 1) {}

  async init(): Promise<void> {
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB is not available in this environment. Use MemoryStorage or SQLiteStorage instead.');
    }
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: 'id' });
          store.createIndex('conversationId', 'conversationId', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('conversations')) {
          db.createObjectStore('conversations', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('contacts')) {
          db.createObjectStore('contacts', { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains('cursors')) {
          db.createObjectStore('cursors', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('outbox')) {
          const store = db.createObjectStore('outbox', { keyPath: 'id' });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  private tx(stores: string | string[], mode: IDBTransactionMode = 'readonly'): IDBTransaction {
    if (!this.db) throw new Error('IndexedDB not initialized. Call init() first.');
    return this.db.transaction(stores, mode);
  }

  private req<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ── Messages ────────────────────────────────────────────────

  async putMessages(messages: StoredMessage[]): Promise<void> {
    const tx = this.tx('messages', 'readwrite');
    const store = tx.objectStore('messages');
    for (const m of messages) store.put(m);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getMessages(conversationId: string, opts: { limit: number; before?: string }): Promise<StoredMessage[]> {
    const tx = this.tx('messages');
    const store = tx.objectStore('messages');
    const idx = store.index('conversationId');
    const all: StoredMessage[] = await this.req(idx.getAll(conversationId));
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (opts.before) {
      const i = all.findIndex(m => m.id === opts.before);
      if (i > 0) return all.slice(Math.max(0, i - opts.limit), i);
    }
    return all.slice(-opts.limit);
  }

  async getMessage(messageId: string): Promise<StoredMessage | null> {
    const tx = this.tx('messages');
    const result = await this.req(tx.objectStore('messages').get(messageId));
    return result ?? null;
  }

  async deleteMessage(messageId: string): Promise<void> {
    const tx = this.tx('messages', 'readwrite');
    tx.objectStore('messages').delete(messageId);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ── Conversations ───────────────────────────────────────────

  async putConversations(conversations: StoredConversation[]): Promise<void> {
    const tx = this.tx('conversations', 'readwrite');
    const store = tx.objectStore('conversations');
    for (const c of conversations) store.put(c);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getConversations(opts?: { limit: number; offset?: number }): Promise<StoredConversation[]> {
    const tx = this.tx('conversations');
    const all: StoredConversation[] = await this.req(tx.objectStore('conversations').getAll());
    all.sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt));
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return all.slice(offset, offset + limit);
  }

  async getConversation(id: string): Promise<StoredConversation | null> {
    const tx = this.tx('conversations');
    const result = await this.req(tx.objectStore('conversations').get(id));
    return result ?? null;
  }

  // ── Contacts ────────────────────────────────────────────────

  async putContacts(contacts: StoredContact[]): Promise<void> {
    const tx = this.tx('contacts', 'readwrite');
    const store = tx.objectStore('contacts');
    for (const c of contacts) store.put(c);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getContacts(): Promise<StoredContact[]> {
    const tx = this.tx('contacts');
    return this.req(tx.objectStore('contacts').getAll());
  }

  // ── Cursors ─────────────────────────────────────────────────

  async getCursor(key: string): Promise<string | null> {
    const tx = this.tx('cursors');
    const result = await this.req(tx.objectStore('cursors').get(key));
    return result?.value ?? null;
  }

  async setCursor(key: string, value: string): Promise<void> {
    const tx = this.tx('cursors', 'readwrite');
    tx.objectStore('cursors').put({ key, value });
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ── Outbox ──────────────────────────────────────────────────

  async enqueue(op: OutboxOperation): Promise<void> {
    const tx = this.tx('outbox', 'readwrite');
    tx.objectStore('outbox').put(op);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async dequeueReady(limit: number): Promise<OutboxOperation[]> {
    const tx = this.tx('outbox', 'readwrite');
    const store = tx.objectStore('outbox');
    const idx = store.index('status');
    const pending: OutboxOperation[] = await this.req(idx.getAll('pending'));
    pending.sort((a, b) => a.createdAt - b.createdAt);
    const batch = pending.slice(0, limit);

    for (const op of batch) {
      op.status = 'inflight';
      store.put(op);
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(batch);
      tx.onerror = () => reject(tx.error);
    });
  }

  async ack(opId: string): Promise<void> {
    const tx = this.tx('outbox', 'readwrite');
    tx.objectStore('outbox').delete(opId);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async nack(opId: string, error: string, retries: number): Promise<void> {
    const tx = this.tx('outbox', 'readwrite');
    const store = tx.objectStore('outbox');
    const op: OutboxOperation | undefined = await this.req(store.get(opId));
    if (!op) return;
    op.retries = retries;
    op.lastError = error;
    op.status = retries >= op.maxRetries ? 'failed' : 'pending';
    store.put(op);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getPendingCount(): Promise<number> {
    const tx = this.tx('outbox');
    const idx = tx.objectStore('outbox').index('status');
    const pending = await this.req(idx.count('pending'));
    const inflight = await this.req(idx.count('inflight'));
    return pending + inflight;
  }

  // ── Search ─────────────────────────────────────────────────

  async searchMessages(query: string, opts?: { conversationId?: string; limit?: number }): Promise<StoredMessage[]> {
    const lower = query.toLowerCase();
    const limit = opts?.limit ?? 50;
    const tx = this.tx('messages');
    let all: StoredMessage[];
    if (opts?.conversationId) {
      const idx = tx.objectStore('messages').index('conversationId');
      all = await this.req(idx.getAll(opts.conversationId));
    } else {
      all = await this.req(tx.objectStore('messages').getAll());
    }
    return all
      .filter(m => (m.content ?? '').toLowerCase().includes(lower))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  // ── Quota ─────────────────────────────────────────────────

  async getStorageSize(): Promise<{ messages: number; conversations: number; total: number }> {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      const total = est.usage ?? 0;
      // Rough split — we can't easily separate stores
      return { messages: Math.floor(total * 0.8), conversations: Math.floor(total * 0.2), total };
    }
    // Fallback: count records
    const tx = this.tx(['messages', 'conversations']);
    const msgCount = await this.req(tx.objectStore('messages').count());
    const convCount = await this.req(tx.objectStore('conversations').count());
    return { messages: msgCount * 500, conversations: convCount * 200, total: msgCount * 500 + convCount * 200 };
  }

  async clearOldMessages(conversationId: string, keepCount: number): Promise<number> {
    const tx = this.tx('messages', 'readwrite');
    const store = tx.objectStore('messages');
    const idx = store.index('conversationId');
    const all: StoredMessage[] = await this.req(idx.getAll(conversationId));
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const toDelete = all.slice(keepCount);
    for (const m of toDelete) store.delete(m.id);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(toDelete.length);
      tx.onerror = () => reject(tx.error);
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async clear(): Promise<void> {
    const tx = this.tx(IDB_STORES as unknown as string[], 'readwrite');
    for (const name of IDB_STORES) tx.objectStore(name).clear();
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

// ============================================================================
// SQLiteStorage — Node.js / Electron / React Native persistent storage
// ============================================================================

/**
 * SQLiteStorage uses `better-sqlite3` for synchronous, fast local persistence.
 * Includes FTS5 full-text search for message content.
 *
 * Usage:
 *   import { SQLiteStorage } from 'prismer/storage';
 *   const storage = new SQLiteStorage('./my-app.db');
 *   await storage.init();
 */
export class SQLiteStorage implements StorageAdapter {
  private db: any = null; // better-sqlite3 Database
  private dbPath: string;

  constructor(dbPath: string = 'prismer-offline.db') {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    // Dynamic import to avoid bundling better-sqlite3 in browser builds
    let Database: any;
    try {
      Database = require('better-sqlite3');
    } catch {
      throw new Error(
        'SQLiteStorage requires the "better-sqlite3" package. ' +
        'Install it with: npm install better-sqlite3\n' +
        'For browser environments, use IndexedDBStorage instead.'
      );
    }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        clientId TEXT,
        conversationId TEXT NOT NULL,
        content TEXT,
        type TEXT DEFAULT 'text',
        senderId TEXT,
        parentId TEXT,
        status TEXT DEFAULT 'confirmed',
        metadata TEXT,
        createdAt TEXT,
        updatedAt TEXT,
        syncSeq INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversationId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(createdAt);

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        type TEXT DEFAULT 'direct',
        title TEXT,
        lastMessage TEXT,
        lastMessageAt TEXT,
        unreadCount INTEGER DEFAULT 0,
        lastReadMessageId TEXT,
        members TEXT,
        metadata TEXT,
        syncSeq INTEGER,
        updatedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS contacts (
        userId TEXT PRIMARY KEY,
        username TEXT,
        displayName TEXT,
        role TEXT,
        conversationId TEXT,
        lastMessageAt TEXT,
        unreadCount INTEGER DEFAULT 0,
        syncSeq INTEGER
      );

      CREATE TABLE IF NOT EXISTS cursors (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        type TEXT,
        method TEXT,
        path TEXT,
        body TEXT,
        query TEXT,
        status TEXT DEFAULT 'pending',
        createdAt INTEGER,
        retries INTEGER DEFAULT 0,
        maxRetries INTEGER DEFAULT 5,
        lastError TEXT,
        idempotencyKey TEXT,
        localData TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, createdAt);
    `);

    // FTS5 for message search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, id UNINDEXED, conversationId UNINDEXED
      );
    `);
  }

  private ensureDb(): any {
    if (!this.db) throw new Error('SQLiteStorage not initialized. Call init() first.');
    return this.db;
  }

  // ── Messages ────────────────────────────────────────────────

  async putMessages(messages: StoredMessage[]): Promise<void> {
    const db = this.ensureDb();
    const insert = db.prepare(`
      INSERT OR REPLACE INTO messages (id, clientId, conversationId, content, type, senderId, parentId, status, metadata, createdAt, updatedAt, syncSeq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(`
      INSERT OR REPLACE INTO messages_fts (rowid, content, id, conversationId)
      VALUES ((SELECT rowid FROM messages WHERE id = ?), ?, ?, ?)
    `);
    const txn = db.transaction((msgs: StoredMessage[]) => {
      for (const m of msgs) {
        insert.run(m.id, m.clientId ?? null, m.conversationId, m.content, m.type, m.senderId,
          m.parentId ?? null, m.status, m.metadata ? JSON.stringify(m.metadata) : null,
          m.createdAt, m.updatedAt ?? null, m.syncSeq ?? null);
        if (m.content) {
          insertFts.run(m.id, m.content, m.id, m.conversationId);
        }
      }
    });
    txn(messages);
  }

  async getMessages(conversationId: string, opts: { limit: number; before?: string }): Promise<StoredMessage[]> {
    const db = this.ensureDb();
    let rows: any[];
    if (opts.before) {
      const beforeRow = db.prepare('SELECT createdAt FROM messages WHERE id = ?').get(opts.before) as any;
      if (beforeRow) {
        rows = db.prepare(
          'SELECT * FROM messages WHERE conversationId = ? AND createdAt < ? ORDER BY createdAt DESC LIMIT ?'
        ).all(conversationId, beforeRow.createdAt, opts.limit);
      } else {
        rows = db.prepare(
          'SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt DESC LIMIT ?'
        ).all(conversationId, opts.limit);
      }
    } else {
      rows = db.prepare(
        'SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt DESC LIMIT ?'
      ).all(conversationId, opts.limit);
    }
    return rows.reverse().map(this.rowToMessage);
  }

  async getMessage(messageId: string): Promise<StoredMessage | null> {
    const db = this.ensureDb();
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    return row ? this.rowToMessage(row) : null;
  }

  async deleteMessage(messageId: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
    db.prepare('DELETE FROM messages_fts WHERE id = ?').run(messageId);
  }

  private rowToMessage(row: any): StoredMessage {
    return {
      id: row.id,
      clientId: row.clientId ?? undefined,
      conversationId: row.conversationId,
      content: row.content ?? '',
      type: row.type ?? 'text',
      senderId: row.senderId ?? '',
      parentId: row.parentId ?? null,
      status: row.status ?? 'confirmed',
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.createdAt ?? '',
      updatedAt: row.updatedAt ?? undefined,
      syncSeq: row.syncSeq ?? undefined,
    };
  }

  // ── Conversations ───────────────────────────────────────────

  async putConversations(conversations: StoredConversation[]): Promise<void> {
    const db = this.ensureDb();
    const insert = db.prepare(`
      INSERT OR REPLACE INTO conversations (id, type, title, lastMessage, lastMessageAt, unreadCount, lastReadMessageId, members, metadata, syncSeq, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const txn = db.transaction((convs: StoredConversation[]) => {
      for (const c of convs) {
        insert.run(c.id, c.type, c.title ?? null,
          c.lastMessage ? JSON.stringify(c.lastMessage) : null,
          c.lastMessageAt ?? null, c.unreadCount, c.lastReadMessageId ?? null,
          c.members ? JSON.stringify(c.members) : null,
          c.metadata ? JSON.stringify(c.metadata) : null,
          c.syncSeq ?? null, c.updatedAt);
      }
    });
    txn(conversations);
  }

  async getConversations(opts?: { limit: number; offset?: number }): Promise<StoredConversation[]> {
    const db = this.ensureDb();
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const rows = db.prepare(
      'SELECT * FROM conversations ORDER BY COALESCE(lastMessageAt, updatedAt) DESC LIMIT ? OFFSET ?'
    ).all(limit, offset);
    return rows.map(this.rowToConversation);
  }

  async getConversation(id: string): Promise<StoredConversation | null> {
    const db = this.ensureDb();
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    return row ? this.rowToConversation(row) : null;
  }

  private rowToConversation(row: any): StoredConversation {
    return {
      id: row.id,
      type: row.type ?? 'direct',
      title: row.title ?? undefined,
      lastMessage: row.lastMessage ? JSON.parse(row.lastMessage) : undefined,
      lastMessageAt: row.lastMessageAt ?? undefined,
      unreadCount: row.unreadCount ?? 0,
      lastReadMessageId: row.lastReadMessageId ?? undefined,
      members: row.members ? JSON.parse(row.members) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      syncSeq: row.syncSeq ?? undefined,
      updatedAt: row.updatedAt ?? '',
    };
  }

  // ── Contacts ────────────────────────────────────────────────

  async putContacts(contacts: StoredContact[]): Promise<void> {
    const db = this.ensureDb();
    const insert = db.prepare(`
      INSERT OR REPLACE INTO contacts (userId, username, displayName, role, conversationId, lastMessageAt, unreadCount, syncSeq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const txn = db.transaction((cs: StoredContact[]) => {
      for (const c of cs) {
        insert.run(c.userId, c.username, c.displayName, c.role,
          c.conversationId, c.lastMessageAt ?? null, c.unreadCount, c.syncSeq ?? null);
      }
    });
    txn(contacts);
  }

  async getContacts(): Promise<StoredContact[]> {
    const db = this.ensureDb();
    return db.prepare('SELECT * FROM contacts').all().map((row: any) => ({
      userId: row.userId,
      username: row.username ?? '',
      displayName: row.displayName ?? '',
      role: row.role ?? 'member',
      conversationId: row.conversationId ?? '',
      lastMessageAt: row.lastMessageAt ?? undefined,
      unreadCount: row.unreadCount ?? 0,
      syncSeq: row.syncSeq ?? undefined,
    }));
  }

  // ── Cursors ─────────────────────────────────────────────────

  async getCursor(key: string): Promise<string | null> {
    const db = this.ensureDb();
    const row = db.prepare('SELECT value FROM cursors WHERE key = ?').get(key) as any;
    return row?.value ?? null;
  }

  async setCursor(key: string, value: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare('INSERT OR REPLACE INTO cursors (key, value) VALUES (?, ?)').run(key, value);
  }

  // ── Outbox ──────────────────────────────────────────────────

  async enqueue(op: OutboxOperation): Promise<void> {
    const db = this.ensureDb();
    db.prepare(`
      INSERT OR REPLACE INTO outbox (id, type, method, path, body, query, status, createdAt, retries, maxRetries, lastError, idempotencyKey, localData)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(op.id, op.type, op.method, op.path,
      op.body ? JSON.stringify(op.body) : null,
      op.query ? JSON.stringify(op.query) : null,
      op.status, op.createdAt, op.retries, op.maxRetries,
      op.lastError ?? null, op.idempotencyKey,
      op.localData ? JSON.stringify(op.localData) : null);
  }

  async dequeueReady(limit: number): Promise<OutboxOperation[]> {
    const db = this.ensureDb();
    const rows = db.prepare(
      'SELECT * FROM outbox WHERE status = ? ORDER BY createdAt ASC LIMIT ?'
    ).all('pending', limit);
    const ops = rows.map(this.rowToOutbox);
    // Mark as inflight
    const update = db.prepare('UPDATE outbox SET status = ? WHERE id = ?');
    const txn = db.transaction((items: OutboxOperation[]) => {
      for (const op of items) update.run('inflight', op.id);
    });
    txn(ops);
    return ops.map((op: OutboxOperation) => ({ ...op, status: 'inflight' as const }));
  }

  async ack(opId: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare('DELETE FROM outbox WHERE id = ?').run(opId);
  }

  async nack(opId: string, error: string, retries: number): Promise<void> {
    const db = this.ensureDb();
    const row = db.prepare('SELECT maxRetries FROM outbox WHERE id = ?').get(opId) as any;
    const newStatus = row && retries >= row.maxRetries ? 'failed' : 'pending';
    db.prepare('UPDATE outbox SET retries = ?, lastError = ?, status = ? WHERE id = ?')
      .run(retries, error, newStatus, opId);
  }

  async getPendingCount(): Promise<number> {
    const db = this.ensureDb();
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM outbox WHERE status IN ('pending', 'inflight')"
    ).get() as any;
    return row?.cnt ?? 0;
  }

  // ── Search (FTS5) ─────────────────────────────────────────

  async searchMessages(query: string, opts?: { conversationId?: string; limit?: number }): Promise<StoredMessage[]> {
    const db = this.ensureDb();
    const limit = opts?.limit ?? 50;
    // Escape FTS5 special characters
    const safeQuery = query.replace(/['"*(){}[\]^~\\]/g, ' ').trim();
    if (!safeQuery) return [];

    let rows: any[];
    if (opts?.conversationId) {
      rows = db.prepare(`
        SELECT m.* FROM messages m
        JOIN messages_fts f ON m.id = f.id
        WHERE messages_fts MATCH ? AND m.conversationId = ?
        ORDER BY m.createdAt DESC LIMIT ?
      `).all(safeQuery, opts.conversationId, limit);
    } else {
      rows = db.prepare(`
        SELECT m.* FROM messages m
        JOIN messages_fts f ON m.id = f.id
        WHERE messages_fts MATCH ?
        ORDER BY m.createdAt DESC LIMIT ?
      `).all(safeQuery, limit);
    }
    return rows.map(this.rowToMessage);
  }

  // ── Quota ─────────────────────────────────────────────────

  async getStorageSize(): Promise<{ messages: number; conversations: number; total: number }> {
    const db = this.ensureDb();
    const pageSize = (db.pragma('page_size', { simple: true }) as number) ?? 4096;
    const pageCount = (db.pragma('page_count', { simple: true }) as number) ?? 0;
    const total = pageSize * pageCount;

    const msgCount = (db.prepare('SELECT COUNT(*) as cnt FROM messages').get() as any)?.cnt ?? 0;
    const convCount = (db.prepare('SELECT COUNT(*) as cnt FROM conversations').get() as any)?.cnt ?? 0;
    const totalRecords = msgCount + convCount;
    const msgRatio = totalRecords > 0 ? msgCount / totalRecords : 0.8;

    return {
      messages: Math.floor(total * msgRatio),
      conversations: Math.floor(total * (1 - msgRatio)),
      total,
    };
  }

  async clearOldMessages(conversationId: string, keepCount: number): Promise<number> {
    const db = this.ensureDb();
    // Get IDs to keep (newest keepCount)
    const keepIds = db.prepare(
      'SELECT id FROM messages WHERE conversationId = ? ORDER BY createdAt DESC LIMIT ?'
    ).all(conversationId, keepCount).map((r: any) => r.id);

    if (keepIds.length === 0) return 0;

    const placeholders = keepIds.map(() => '?').join(',');
    const result = db.prepare(
      `DELETE FROM messages WHERE conversationId = ? AND id NOT IN (${placeholders})`
    ).run(conversationId, ...keepIds);

    // Clean up FTS
    db.prepare(
      `DELETE FROM messages_fts WHERE conversationId = ? AND id NOT IN (${placeholders})`
    ).run(conversationId, ...keepIds);

    return result.changes;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async clear(): Promise<void> {
    const db = this.ensureDb();
    db.exec('DELETE FROM messages; DELETE FROM messages_fts; DELETE FROM conversations; DELETE FROM contacts; DELETE FROM cursors; DELETE FROM outbox;');
  }

  private rowToOutbox(row: any): OutboxOperation {
    return {
      id: row.id,
      type: row.type,
      method: row.method,
      path: row.path,
      body: row.body ? JSON.parse(row.body) : undefined,
      query: row.query ? JSON.parse(row.query) : undefined,
      status: row.status,
      createdAt: row.createdAt,
      retries: row.retries ?? 0,
      maxRetries: row.maxRetries ?? 5,
      lastError: row.lastError ?? undefined,
      idempotencyKey: row.idempotencyKey ?? '',
      localData: row.localData ? JSON.parse(row.localData) : undefined,
    };
  }
}
