# Prismer TypeScript SDK — Architecture & Design Reference

> **Version:** 1.7.2 — Agent Intelligence Platform (Evolution, Memory, Tasks, Skills)
> **Package:** `@prismer/sdk`
> **Source:** `sdk/typescript/src/`

This document is the authoritative technical reference for the Prismer TypeScript SDK.
It describes the actual implemented architecture, not aspirational features.

---

## 1. Module Map

```
@prismer/sdk v1.7.2
├── index.ts              ← PrismerClient + all IM sub-clients (~890 lines)
├── types.ts              ← All TypeScript type definitions (~505 lines)
├── realtime.ts           ← RealtimeWSClient + RealtimeSSEClient (653 lines)
├── storage.ts            ← StorageAdapter + MemoryStorage + IndexedDBStorage + SQLiteStorage (~750 lines)
├── offline.ts            ← OfflineManager + outbox + sync + SSE + AttachmentQueue (~1020 lines)
├── multitab.ts           ← TabCoordinator: BroadcastChannel multi-tab coordination (~145 lines)
├── encryption.ts         ← E2EEncryption: AES-256-GCM + ECDH P-256 (~280 lines)
├── webhook.ts            ← PrismerWebhook: HMAC-SHA256 verification + framework adapters
└── cli.ts                ← Prismer CLI: init, register, status, config
```

### Dependency Graph

```
index.ts
├── types.ts       (all type imports)
├── realtime.ts    (RealtimeWSClient, RealtimeSSEClient)
├── offline.ts     (OfflineManager, AttachmentQueue)
│   ├── storage.ts (StorageAdapter, StoredMessage, OutboxOperation, etc.)
│   └── types.ts   (RequestFn, IMResult, OfflineConfig)
├── multitab.ts    (TabCoordinator — BroadcastChannel)
│   └── offline.ts (OfflineManager for leader/passive coordination)
├── encryption.ts  (E2EEncryption — standalone crypto module)
└── (re-exports all modules)

webhook.ts         (standalone, no imports from index)
cli.ts             (imports PrismerClient from index)
```

No runtime dependencies beyond Node.js built-ins and `commander` (CLI only).
The SDK is isomorphic — works in browsers, Node.js, Deno, and Bun.

---

## 2. Client Architecture

### 2.1 Class Hierarchy

```
PrismerClient
│
├── Context API (direct methods)
│   ├── load(input, options)         → POST /api/context/load
│   ├── save(options)                → POST /api/context/save
│   ├── saveBatch(items)             → POST /api/context/save
│   └── search(query, options)       → POST /api/context/load (query mode)
│
├── Parse API (direct methods)
│   ├── parse(options)               → POST /api/parse
│   ├── parsePdf(url, mode)          → POST /api/parse
│   ├── parseStatus(taskId)          → GET /api/parse/status/:taskId
│   └── parseResult(taskId)          → GET /api/parse/result/:taskId
│
└── im: IMClient (orchestrator)
    ├── account: AccountClient       → register, me, refreshToken
    ├── direct: DirectClient         → send, getMessages
    ├── groups: GroupsClient         → create, list, get, send, getMessages, addMember, removeMember
    ├── conversations: ConversationsClient → list, get, createDirect, markAsRead
    ├── messages: MessagesClient     → send, getHistory, edit, delete
    ├── contacts: ContactsClient     → list, discover
    ├── bindings: BindingsClient     → create, verify, list, delete
    ├── credits: CreditsClient       → get, transactions
    ├── workspace: WorkspaceClient   → init, initGroup, addAgent, listAgents, mentionAutocomplete
    ├── files: FilesClient           → presign, confirm, upload, sendFile, multipart
    ├── realtime: IMRealtimeClient   → connectWS, connectSSE (factory)
    └── offline: OfflineManager | null → sync, flush, setOnline, on/off events
```

### 2.2 Request Flow

All API calls go through the internal `_request()` method on `PrismerClient`:

```
Application code
  │
  └── client.im.direct.send('user-1', 'Hello')
        │
        └── DirectClient._r('POST', '/api/im/direct/user-1/messages', body)
              │
              ├── [offline enabled] → OfflineManager.dispatch()
              │     ├── Write op? → outbox queue (optimistic local write)
              │     └── Read op?  → local cache → miss → network
              │
              └── [offline disabled] → PrismerClient._request()
                    │
                    ├── Build URL: baseUrl + path + query
                    ├── Set headers: Authorization, X-IM-Agent, Content-Type
                    ├── fetch() with AbortController timeout
                    │
                    ├── 401 + JWT token? → auto-refresh → retry once
                    └── Return parsed JSON
```

### 2.3 Authentication Model

The SDK supports two auth modes, set via `config.apiKey`:

|                  | API Key (`sk-prismer-*`)        | IM JWT (`eyJ*`)                                  |
| ---------------- | ------------------------------- | ------------------------------------------------ |
| **Obtained via** | Dashboard / manual              | `im.account.register()`                          |
| **Expiry**       | Never                           | 24 hours                                         |
| **Route**        | Next.js BFF proxy (`/api/im/*`) | Direct to IM server                              |
| **Auto-refresh** | N/A                             | Yes — on 401, calls `POST /api/im/token/refresh` |
| **Use case**     | Server-side apps, API clients   | Agent self-registration, direct-connect          |

Auto-refresh logic (in `_request()`):

1. Detect 401 response + token starts with `eyJ` + not already retrying
2. Call `POST /api/im/token/refresh` (with current expired token)
3. If refresh returns new token → update `this.apiKey` → retry original request
4. If refresh fails → return original 401 error

---

## 3. Offline-First Architecture

Enabled via `config.offline`. When not configured, the SDK behaves as a stateless HTTP client (no local storage, no outbox, no sync).

### 3.1 Layered Architecture

```
┌──────────────────────────────────────────────────────┐
│  Application Code                                     │
│  client.im.direct.send('user-1', 'Hello')            │
│  client.im.conversations.list()                      │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│  IM Sub-Clients (unchanged API surface)              │
│  AccountClient / DirectClient / GroupsClient / ...   │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│  OfflineManager (offline.ts)                         │
│                                                      │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Outbox Queue │  │ Sync     │  │ Read Cache    │  │
│  │              │  │ Engine   │  │               │  │
│  │ Write ops    │  │ Cursor-  │  │ Conversations │  │
│  │ queued with  │  │ based    │  │ Messages      │  │
│  │ idempotency  │  │ catch-up │  │ Contacts      │  │
│  │ keys         │  │ via      │  │               │  │
│  │              │  │ /api/im/ │  │ Local-first   │  │
│  │ Auto-flush   │  │ sync     │  │ reads         │  │
│  └──────────────┘  └──────────┘  └───────────────┘  │
└──────┬───────────────────┬───────────────────────────┘
       │                   │
┌──────▼──────┐   ┌────────▼──────────────────────────┐
│ Storage     │   │ Network Layer                      │
│ Adapter     │   │                                    │
│             │   │  PrismerClient._request()           │
│ IndexedDB   │   │  (HTTP + auto JWT refresh)         │
│ Memory      │   │                                    │
│ (custom)    │   │  RealtimeWSClient / RealtimeSSEClient│
└─────────────┘   └────────────────────────────────────┘
```

### 3.2 Storage Adapter Interface

```typescript
interface StorageAdapter {
  init(): Promise<void>;

  // Messages
  putMessages(messages: StoredMessage[]): Promise<void>;
  getMessages(conversationId: string, opts: { limit: number; before?: string }): Promise<StoredMessage[]>;
  getMessage(messageId: string): Promise<StoredMessage | null>;
  deleteMessage(messageId: string): Promise<void>;

  // Conversations
  putConversations(conversations: StoredConversation[]): Promise<void>;
  getConversations(opts?: { limit: number; offset?: number }): Promise<StoredConversation[]>;
  getConversation(id: string): Promise<StoredConversation | null>;

  // Contacts
  putContacts(contacts: StoredContact[]): Promise<void>;
  getContacts(): Promise<StoredContact[]>;

  // Sync cursors
  getCursor(key: string): Promise<string | null>;
  setCursor(key: string, value: string): Promise<void>;

  // Outbox (pending write operations)
  enqueue(op: OutboxOperation): Promise<void>;
  dequeueReady(limit: number): Promise<OutboxOperation[]>;
  ack(opId: string): Promise<void>;
  nack(opId: string, error: string, retries: number): Promise<void>;
  getPendingCount(): Promise<number>;

  // Lifecycle
  clear(): Promise<void>;
}
```

Built-in implementations:

| Adapter            | Environment        | Persistence              | Notes                                                                              |
| ------------------ | ------------------ | ------------------------ | ---------------------------------------------------------------------------------- |
| `MemoryStorage`    | Any                | Process lifetime only    | Testing, stateless agents                                                          |
| `IndexedDBStorage` | Browser            | Survives refresh/restart | 5 object stores: messages, conversations, contacts, cursors, outbox                |
| `SQLiteStorage`    | Node.js / Electron | Disk (WAL mode)          | `better-sqlite3`, FTS5 full-text search, `PRAGMA page_count * page_size` for quota |

Optional `StorageAdapter` methods (implemented in all three adapters):

```typescript
// Full-text search (FTS5 in SQLiteStorage, content.includes() fallback in others)
searchMessages?(query: string, opts?: { conversationId?: string; limit?: number }): Promise<StoredMessage[]>;
// Storage quota info
getStorageSize?(): Promise<{ messages: number; conversations: number; total: number }>;
// User-initiated cleanup
clearOldMessages?(conversationId: string, keepCount: number): Promise<number>;
```

### 3.3 Outbox Queue (Offline Message Sending)

All IM write operations are routed through the outbox when offline mode is enabled:

```
client.im.direct.send('user-1', 'Hello')
  │
  ├─ 1. Generate clientId (UUID) + idempotencyKey ("sdk-{clientId}")
  ├─ 2. Inject _idempotencyKey into body.metadata
  ├─ 3. Write optimistic local message (status: 'pending')
  ├─ 4. Enqueue OutboxOperation to storage
  ├─ 5. Emit 'message.local' event (UI can render immediately)
  ├─ 6. Return optimistic result: { ok: true, data: {...}, _pending: true }
  │
  ├─ [online] Flush timer picks up immediately
  │   ├─ POST to server with idempotencyKey in metadata
  │   ├─ 200: ack() → replace local message with server data → emit 'message.confirmed'
  │   ├─ 4xx: permanent failure → emit 'message.failed'
  │   └─ 5xx/timeout: nack() → retry with exponential backoff (up to maxRetries)
  │
  └─ [offline] Stays in outbox
      └─ On reconnect: flush() sends all pending operations in order
```

Write operations detected by URL pattern matching:

| Pattern                                    | Operation Type      |
| ------------------------------------------ | ------------------- |
| `POST /api/im/(messages\|direct\|groups)/` | `message.send`      |
| `PATCH /api/im/messages/`                  | `message.edit`      |
| `DELETE /api/im/messages/`                 | `message.delete`    |
| `POST /api/im/conversations/.*/read`       | `conversation.read` |

### 3.4 Sync Engine

Two sync modes, configured via `OfflineConfig.syncMode`:

**Push mode (default: `'push'`)** — SSE continuous sync via `GET /api/im/sync/stream`:

```
On connect / reconnect:
  │
  ├─ 1. Load global_sync cursor from local storage (default: "0")
  ├─ 2. Open SSE: GET /api/im/sync/stream?token={jwt}&since={cursor}
  ├─ 3. Catch-up: server sends all events since cursor
  ├─ 4. Server sends event: "caught_up" → emit 'sync.complete'
  ├─ 5. Real-time: receive new events as they occur (Redis pub/sub)
  ├─ 6. On disconnect: reconnect with exponential backoff (1s → 30s cap)
  └─ 7. Heartbeat every 25s keeps connection alive
```

**Poll mode (`'poll'`)** — cursor-based polling against `GET /api/im/sync`:

```
On connect / reconnect / manual sync():
  │
  ├─ 1. Load global_sync cursor from local storage (default: "0")
  ├─ 2. GET /api/im/sync?since={cursor}&limit=100
  ├─ 3. For each event: apply locally
  ├─ 4. Update cursor, repeat if hasMore
  └─ 5. Emit 'sync.complete'
```

**Sync event types handled:**

| Event Type             | Action                                              |
| ---------------------- | --------------------------------------------------- |
| `message.new`          | `putMessages()` with status 'confirmed'             |
| `message.edit`         | Update content/updatedAt (with conflict resolution) |
| `message.delete`       | `deleteMessage()`                                   |
| `conversation.create`  | `putConversations()`                                |
| `conversation.update`  | `putConversations()`                                |
| `conversation.archive` | Mark metadata `_archived: true`                     |
| `participant.add`      | Append to conversation members                      |
| `participant.remove`   | Remove from conversation members                    |

Events emitted during sync lifecycle:

| Event           | Payload                                 | When                   |
| --------------- | --------------------------------------- | ---------------------- |
| `sync.start`    | —                                       | Sync begins            |
| `sync.progress` | `{ synced, total }`                     | After each batch/event |
| `sync.complete` | `{ newMessages, updatedConversations }` | All events applied     |
| `sync.error`    | `{ error, willRetry }`                  | Sync failed            |

### 3.5 Read Cache

GET requests for conversations, messages, and contacts check local storage first:

| Path Pattern                | Cache Source                 |
| --------------------------- | ---------------------------- |
| `GET /api/im/conversations` | `storage.getConversations()` |
| `GET /api/im/messages/{id}` | `storage.getMessages(id)`    |
| `GET /api/im/contacts`      | `storage.getContacts()`      |

Cache strategy: **local-first with background refresh**. If local cache has data, return it immediately. Network result (when available) updates the cache for next read.

### 3.6 Event System

`OfflineManager` extends a typed event emitter. All events:

```typescript
interface OfflineEventMap {
  // Sync lifecycle
  'sync.start': undefined;
  'sync.progress': { synced: number; total: number };
  'sync.complete': { newMessages: number; updatedConversations: number };
  'sync.error': { error: string; willRetry: boolean };

  // Outbox lifecycle
  'outbox.sending': { opId: string; type: string };
  'outbox.confirmed': { opId: string; serverData: any };
  'outbox.failed': { opId: string; error: string; retriesLeft: number };

  // Message lifecycle (optimistic UI)
  'message.local': StoredMessage; // Locally queued, render immediately
  'message.confirmed': { clientId: string; serverMessage: any }; // Server confirmed
  'message.failed': { clientId: string; error: string }; // Permanent failure

  // Network state
  'network.online': undefined;
  'network.offline': undefined;

  // Presence (from realtime events)
  'presence.changed': { userId: string; status: string; lastSeen?: string };

  // Storage quota
  'quota.warning': { used: number; limit: number; percentage: number };
  'quota.exceeded': { used: number; limit: number };
}
```

---

## 4. Server-Side Support

The offline-first SDK requires server-side endpoints. All are implemented in the IM server.

### 4.1 Sync Endpoint

```
GET /api/im/sync?since={cursor}&limit={limit}

Response: {
  ok: true,
  data: {
    events: [{ seq, type, data, conversationId, at }],
    cursor: number,    // Use as next `since` value
    hasMore: boolean
  }
}
```

**Implementation:** `src/im/api/sync.ts` + `src/im/services/sync.service.ts`

**Storage:** `im_sync_events` table (auto-increment ID as cursor)

**Access control:** Only returns events for conversations the user participates in (queries `im_participants`), plus user's own events.

**Event generation:**

`MessageService` writes sync events on:

- `message.new` — after `messageModel.create()`
- `message.edit` — after `messageModel.update()`
- `message.delete` — after `messageModel.delete()`

`ConversationService` writes sync events for **all conversation participants** on:

- `conversation.create` — after `createDirect()` or `createGroup()`
- `conversation.update` — after `update()`
- `conversation.archive` — after `archive()`
- `participant.add` — after `addParticipant()`
- `participant.remove` — before `removeParticipant()` (so removed user receives the event)

### 4.2 SSE Sync Stream

```
GET /api/im/sync/stream?token={jwt}&since={cursor}

SSE events:
  event: sync       data: {"seq":1,"type":"message.new","data":{...},"at":"..."}
  event: caught_up  data: {"cursor":42}
  event: heartbeat  data: {"ts":"..."}
```

**Implementation:** `src/im/api/sync-stream.ts`

**Flow:**

1. Authenticate via `?token=` query param
2. Catch-up: fetch all events since cursor, stream each as `event: sync`
3. Send `event: caught_up` when historical events are exhausted
4. Subscribe to Redis channel `im:sync:{userId}` for real-time push
5. New events published by any service flow through Redis to SSE
6. Heartbeat every 25s keeps connection alive

### 4.2 Idempotency

Server-side deduplication prevents duplicate messages from outbox retries.

**Two injection paths:**

1. `metadata._idempotencyKey` — SDK outbox injects this into the request body
2. `X-Idempotency-Key` header — API routes merge this into metadata

**Dedup logic** (in `MessageService.send()`):

1. Extract `_idempotencyKey` from `input.metadata`
2. Search `im_messages` for matching key in metadata (last 24h, same conversation)
3. If found → return existing message without creating a new one

**Covered endpoints:**

- `POST /api/im/messages/:conversationId` (`messages.ts`)
- `POST /api/im/direct/:userId/messages` (`direct.ts`)
- `POST /api/im/groups/:groupId/messages` (`groups.ts`)

### 4.3 JWT Token Refresh

```
POST /api/im/token/refresh
Authorization: Bearer <expired-jwt>

Response: { ok: true, data: { token: "<new-jwt>", expiresIn: "24h" } }
```

**Implementation:** `src/im/api/register.ts` — accepts expired tokens within a grace period.

**SDK integration:** `PrismerClient._request()` catches 401, attempts refresh, retries once.

### 4.4 Database Schema

```sql
-- src/im/sql/005-sync-events.sql
CREATE TABLE im_sync_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  conversationId VARCHAR(30) NULL,
  imUserId VARCHAR(30) NOT NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_im_sync_events_userId (imUserId),
  INDEX idx_im_sync_events_conversationId (conversationId)
);
```

Prisma models in both `prisma/schema.prisma` (SQLite) and `prisma/schema.mysql.prisma` (MySQL).

---

## 5. Realtime Layer

### 5.1 WebSocket Client

`RealtimeWSClient` — full-duplex communication via `ws://.../ws?token={jwt}`.

Features:

- Auto-reconnect with exponential backoff (1s → 2s → 4s → ... → 30s cap)
- Heartbeat: sends `{"type":"ping"}` every 30s, expects pong within 10s
- Typed event emitter: `message.new`, `typing.indicator`, `presence.changed`, `authenticated`, `error`, `disconnected`, `reconnecting`
- Send commands: `message.send`, `typing.start`, `typing.stop`, `subscribe`, `unsubscribe`

### 5.2 SSE Client

`RealtimeSSEClient` — server-sent events via `GET /sse?token={jwt}`.

Features:

- Read-only event stream (no send capability)
- Watchdog timeout: if no event received in 60s, reconnects
- Auto-reconnect with same backoff strategy as WebSocket
- Same typed event interface as WebSocket client

### 5.3 Factory

```typescript
const ws = client.im.realtime.connectWS({ token, autoReconnect: true });
ws.on('message.new', (msg) => { ... });
await ws.connect();

const sse = client.im.realtime.connectSSE({ token, autoReconnect: true });
sse.on('message.new', (msg) => { ... });
await sse.connect();
```

---

## 6. Webhook Handler

`PrismerWebhook` — receives and verifies webhook payloads from the IM server.

```typescript
const webhook = new PrismerWebhook({
  secret: process.env.WEBHOOK_SECRET!,
  onMessage: async (payload) => {
    console.log(`${payload.sender.displayName}: ${payload.message.content}`);
    return { content: 'Reply from agent' }; // Optional auto-reply
  },
});

// Framework adapters
app.post('/webhook', webhook.express()); // Express
app.post('/webhook', webhook.hono()); // Hono
const response = await webhook.handle(req); // Raw Request/Response
```

Signature verification: `X-Prismer-Signature: sha256={hmac}` using `HMAC-SHA256(secret, body)`.

---

## 7. File Upload

`FilesClient` provides a full lifecycle file upload API:

### Simple upload (< 10 MB)

```
presign(fileName, fileSize, mimeType) → { uploadId, url, fields }
  │
  └─ POST to S3 presigned URL with FormData
       │
       └─ confirm(uploadId) → { uploadId, cdnUrl, fileName, fileSize, mimeType }
```

### Multipart upload (10–50 MB)

```
initMultipart(fileName, fileSize, mimeType) → { uploadId, parts: [{ partNumber, url }] }
  │
  └─ PUT each 5 MB chunk to part URLs
       │
       └─ completeMultipart(uploadId, parts) → { uploadId, cdnUrl, ... }
```

### High-level convenience

```typescript
// Upload a file (auto-selects simple vs multipart)
const result = await client.im.files.upload('/path/to/file.pdf');

// Upload + send as message in one call
const sent = await client.im.files.sendFile('conv-123', file, { content: 'Check this out' });
```

Supported inputs: `File`, `Blob`, `Uint8Array`, `Buffer`, or file path (string, Node.js only).

---

## 8. Configuration

```typescript
interface PrismerConfig {
  apiKey?: string; // sk-prismer-* or JWT (eyJ*)
  environment?: 'production'; // Sets baseUrl to https://prismer.cloud
  baseUrl?: string; // Override (priority over environment)
  timeout?: number; // Request timeout in ms (default: 30000)
  fetch?: typeof fetch; // Custom fetch (for polyfills or testing)
  imAgent?: string; // X-IM-Agent header (select agent identity with API Key)
  offline?: OfflineConfig; // Enable offline mode (omit = stateless HTTP)
}

interface OfflineConfig {
  storage: StorageAdapter; // Required: IndexedDBStorage, MemoryStorage, SQLiteStorage, or custom
  syncOnConnect?: boolean; // Auto-sync on reconnect (default: true)
  outboxRetryLimit?: number; // Max retries per operation (default: 5)
  outboxFlushInterval?: number; // Flush timer interval in ms (default: 1000)
  conflictStrategy?: 'server' | 'client'; // Default: 'server' (LWW)
  onConflict?: (local, remote) => 'keep_local' | 'accept_remote' | StoredMessage; // Custom resolver
  syncMode?: 'push' | 'poll'; // Sync strategy (default: 'push' = SSE)
  multiTab?: boolean; // BroadcastChannel coordination (default: true in browser)
  e2e?: {
    // E2E encryption
    enabled: boolean;
    passphrase: string; // PBKDF2 master key derivation
  };
  quota?: {
    // Storage quota management
    maxStorageBytes?: number; // Default: 500MB
    warningThreshold?: number; // Default: 0.9 (90%)
  };
}
```

---

## 9. API Surface Summary

### Context API

| Method                | Endpoint                 | Description                            |
| --------------------- | ------------------------ | -------------------------------------- |
| `load(input, opts)`   | `POST /api/context/load` | Smart context loader (URL/batch/query) |
| `save(opts)`          | `POST /api/context/save` | Store content in cache                 |
| `search(query, opts)` | `POST /api/context/load` | Search mode convenience wrapper        |

### Parse API

| Method                | Endpoint                        | Description                   |
| --------------------- | ------------------------------- | ----------------------------- |
| `parse(opts)`         | `POST /api/parse`               | Parse document (PDF, images)  |
| `parsePdf(url, mode)` | `POST /api/parse`               | Convenience: parse PDF by URL |
| `parseStatus(taskId)` | `GET /api/parse/status/:taskId` | Poll async task status        |
| `parseResult(taskId)` | `GET /api/parse/result/:taskId` | Get completed task result     |

### IM API

| Sub-Client      | Methods                                                       | Key Endpoints                                               |
| --------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| `account`       | register, me, refreshToken                                    | POST /register, GET /me, POST /token/refresh                |
| `direct`        | send, getMessages                                             | POST /direct/:userId/messages, GET /direct/:userId/messages |
| `groups`        | create, list, get, send, getMessages, addMember, removeMember | /groups/\*                                                  |
| `conversations` | list, get, createDirect, markAsRead                           | /conversations/\*                                           |
| `messages`      | send, getHistory, edit, delete                                | /messages/:convId/\*                                        |
| `contacts`      | list, discover                                                | /contacts, /discover                                        |
| `bindings`      | create, verify, list, delete                                  | /bindings/\*                                                |
| `credits`       | get, transactions                                             | /credits/\*                                                 |
| `workspace`     | init, initGroup, addAgent, listAgents, mentionAutocomplete    | /workspace/\*                                               |
| `files`         | presign, confirm, upload, sendFile, quota, delete, types      | /files/\*                                                   |
| `realtime`      | connectWS, connectSSE                                         | WS /ws, GET /sse                                            |
| `offline`       | sync, flush, setOnline, on/off, destroy                       | GET /sync                                                   |

---

## 10. Implementation Status

### All Implemented (v1.7.0)

**Core SDK:**

- [x] Full IM sub-client hierarchy (12 sub-clients, 50+ methods)
- [x] StorageAdapter interface + MemoryStorage + IndexedDBStorage + **SQLiteStorage**
- [x] Outbox queue with idempotency key injection
- [x] Optimistic local writes with message lifecycle events
- [x] Cursor-based incremental sync engine (polling)
- [x] **SSE continuous sync** (push mode, real-time via Redis pub/sub)
- [x] Read cache (conversations, messages, contacts)
- [x] Auto JWT token refresh on 401
- [x] **Custom conflict resolver** (`onConflict` callback for message.edit)
- [x] **Local message search** (FTS5 in SQLiteStorage, `includes` fallback)
- [x] **Attachment offline queue** (presign → upload → confirm → send)
- [x] **Presence caching** (realtime presence events stored locally)
- [x] **Multi-tab coordination** (BroadcastChannel, last-login-wins protocol)
- [x] **E2E encryption** (AES-256-GCM + ECDH P-256 + PBKDF2 master key)
- [x] **Storage quota management** (warning/exceeded events, user-initiated cleanup)
- [x] WebSocket + SSE realtime clients with auto-reconnect
- [x] Webhook handler with HMAC-SHA256 verification
- [x] File upload (simple + multipart) with sendFile convenience
- [x] CLI tool (init, register, status, config)
- [x] `client.destroy()` for resource cleanup

**Server-side:**

- [x] `im_sync_events` table + `GET /api/im/sync` polling endpoint
- [x] **`GET /api/im/sync/stream`** SSE endpoint with Redis pub/sub
- [x] **Conversation sync events** (create, update, archive, participant add/remove)
- [x] Idempotency check in MessageService (24h dedup window)
- [x] `X-Idempotency-Key` header support on all 3 send endpoints

**Multi-language SDKs:**

- [x] **Python SDK offline sync** (`sdk/python/prismer/offline.py` — MemoryStorage + OfflineManager + polling sync)
- [x] **Go SDK offline sync** (`sdk/golang/offline.go` — MemoryStorage + OfflineManager + polling sync)

---

## 11. File Map

### TypeScript SDK

| File                               | ~Lines | Role                                                           |
| ---------------------------------- | ------ | -------------------------------------------------------------- |
| `sdk/typescript/src/index.ts`      | 890    | PrismerClient, IMClient, 12 sub-clients                        |
| `sdk/typescript/src/types.ts`      | 505    | All TypeScript interfaces and types                            |
| `sdk/typescript/src/realtime.ts`   | 653    | RealtimeWSClient, RealtimeSSEClient                            |
| `sdk/typescript/src/offline.ts`    | 1020   | OfflineManager, outbox, sync, SSE, AttachmentQueue             |
| `sdk/typescript/src/storage.ts`    | 750    | StorageAdapter, MemoryStorage, IndexedDBStorage, SQLiteStorage |
| `sdk/typescript/src/multitab.ts`   | 145    | TabCoordinator (BroadcastChannel)                              |
| `sdk/typescript/src/encryption.ts` | 280    | E2EEncryption (AES-256-GCM, ECDH, PBKDF2)                      |
| `sdk/typescript/src/webhook.ts`    | ~200   | PrismerWebhook, framework adapters                             |
| `sdk/typescript/src/cli.ts`        | ~300   | CLI tool                                                       |

### Python SDK

| File                             | ~Lines | Role                                              |
| -------------------------------- | ------ | ------------------------------------------------- |
| `sdk/python/prismer/client.py`   | 1500   | PrismerClient, AsyncPrismerClient, IM sub-clients |
| `sdk/python/prismer/offline.py`  | 430    | OfflineManager, MemoryStorage, outbox, sync       |
| `sdk/python/prismer/realtime.py` | ~600   | Realtime WS/SSE clients                           |
| `sdk/python/prismer/webhook.py`  | ~200   | PrismerWebhook                                    |

### Go SDK

| File                     | ~Lines | Role                                        |
| ------------------------ | ------ | ------------------------------------------- |
| `sdk/golang/prismer.go`  | 960    | Client, IMClient, all sub-clients           |
| `sdk/golang/offline.go`  | 550    | OfflineManager, MemoryStorage, outbox, sync |
| `sdk/golang/realtime.go` | ~700   | Realtime WS/SSE clients                     |
| `sdk/golang/webhook.go`  | ~200   | Webhook handler                             |

### Server-Side

| File                                      | ~Lines | Role                                      |
| ----------------------------------------- | ------ | ----------------------------------------- |
| `src/im/services/sync.service.ts`         | 90     | Sync event read/write + Redis publish     |
| `src/im/services/conversation.service.ts` | 200    | Conversation CRUD + sync event generation |
| `src/im/api/sync.ts`                      | 42     | GET /api/im/sync polling endpoint         |
| `src/im/api/sync-stream.ts`               | 130    | GET /api/im/sync/stream SSE endpoint      |
| `src/im/sql/005-sync-events.sql`          | 12     | MySQL migration for im_sync_events        |

---

## 12. Design Decisions (v1.7.0)

All previously open questions have been resolved:

1. **Sync event retention:** Permanent — never auto-delete sync events.
2. **Storage full:** Prompt user via `quota.warning`/`quota.exceeded` events. Provide `clearOldMessages()` API for user-initiated cleanup. Default limit: 500MB.
3. **Multi-tab coordination:** BroadcastChannel with "last login wins" protocol. Leader runs outbox flush + sync; passive tabs receive events from leader via broadcast.
4. **E2E encryption:** Industry standard — AES-256-GCM per-conversation symmetric keys, ECDH P-256 key exchange, PBKDF2-SHA256 master key derivation (100k iterations). Server only sees ciphertext.
5. **Sync method:** Continuous push via SSE (default). Polling available as fallback. SSE uses Redis pub/sub for real-time event delivery with catch-up phase for historical events.

## 13. Multi-Language SDK Offline Support

### Python SDK (`sdk/python/prismer/offline.py`)

- `MemoryStorage` — dict-based, same interface as TypeScript
- `OfflineManager` — asyncio-based, outbox queue + polling sync
- Integration: `AsyncPrismerClient(offline={"storage": MemoryStorage()})` + `await client.init_offline()`
- Scope: MemoryStorage only, polling sync, no E2E/multi-tab (server-side features)

### Go SDK (`sdk/golang/offline.go`)

- `MemoryStorage` — goroutine-safe with `sync.RWMutex`
- `OfflineManager` — goroutine-based flush loop + context-aware sync
- Integration: `NewOfflineManager(storage, client, &OfflineOptions{...})`
- Scope: MemoryStorage only, polling sync, no E2E/multi-tab (server-side features)
