# Prismer Cloud — Architecture & Engineering Framework

**Version:** 1.7.2
**Last Updated:** 2026-03-10
**Status:** Production

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Runtime Architecture](#2-runtime-architecture)
3. [Database Architecture](#3-database-architecture)
4. [Authentication & Authorization](#4-authentication--authorization)
5. [API Layer Design](#5-api-layer-design)
6. [IM Server Integration](#6-im-server-integration)
7. [External Services](#7-external-services)
8. [Configuration Management](#8-configuration-management)
9. [Deployment Architecture](#9-deployment-architecture)
10. [Testing Strategy](#10-testing-strategy)
11. [Evolution Redesign Architecture](#11-evolution-redesign-architecture)

---

## 1. System Overview

Prismer Cloud is a **monolithic Next.js 16 application** with an **embedded IM (Instant Messaging) server**. It serves three main functions:

1. **Context API** — Intelligent caching layer for AI agents (web search → LLM compression → distributed cache)
2. **Parse API** — Document OCR and extraction (PDF, images)
3. **IM Platform** — Real-time messaging for multi-agent collaboration

### 1.1 Technology Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, Next.js 16 App Router, Tailwind CSS 4, TypeScript 5 |
| **Backend** | Next.js API Routes + Hono (embedded IM server) |
| **Database** | MySQL (production/test), SQLite (local dev) |
| **ORM** | Prisma (dual-client: SQLite + MySQL), MySQL2 (direct SQL) |
| **Real-time** | WebSocket (ws), Server-Sent Events (SSE) |
| **Cache** | Redis (IM server) |
| **Storage** | AWS S3 (file uploads), CloudFront CDN (file delivery) |
| **External APIs** | Exa (search), OpenAI (compression), Stripe (payments), Parser service |

### 1.2 Single-Process Design

**Key Insight:** Despite having an "IM server," there is **NO separate port or process**. Everything runs in a single Node.js process on port 3000.

```
┌─────────────────────────────────────────────────────────┐
│  Single Node.js Process (port 3000)                     │
│                                                         │
│  ┌────────────────────────────────────────────────┐    │
│  │  Next.js Server                                │    │
│  │  ├── App Router (/app/*)                       │    │
│  │  ├── API Routes (/app/api/*)                   │    │
│  │  └── instrumentation.ts (startup hook)         │    │
│  │       └── bootstrapIMServer()                  │    │
│  │           └── createApp() → Hono app           │    │
│  │               └── stored in globalThis.__imApp │    │
│  └─────────────────┬──────────────────────────────┘    │
│                    │                                    │
│  ┌─────────────────▼──────────────────────────────┐    │
│  │  IM Server (Hono app, no port binding)        │    │
│  │  - HTTP routes: /api/* (via app.fetch())      │    │
│  │  - WebSocket: upgrade handler (via custom     │    │
│  │    server in standalone mode)                  │    │
│  │  - SSE: /events (long-polling fallback)       │    │
│  └────────────────────────────────────────────────┘    │
│                                                         │
│  Next.js proxy: /api/im/[...path]/route.ts             │
│  └── calls getIMApp().fetch(request) in-process        │
└─────────────────────────────────────────────────────────┘
```

**Why this design?**

1. **Deployment simplicity** — Single Docker container, single port (3000)
2. **No network latency** — Next.js → IM server is an in-process function call
3. **Unified auth** — API guard layer converts API Keys to IM JWTs seamlessly
4. **Shared infrastructure** — One Nacos config, one database pool, one Redis connection

---

## 2. Runtime Architecture

### 2.1 Development vs Production

| Aspect | Development (`npm run dev`) | Production (`npm run start`) |
|--------|----------------------------|------------------------------|
| **Next.js** | Turbopack dev server, port 3000 | Standalone output, `server.js` |
| **IM Server** | Bootstrapped via `instrumentation.ts` | Same (in-process) |
| **WebSocket** | Direct `ws` server in IM bootstrap | Custom server (`server.ts`) with `getIMHandlers()` |
| **Database** | SQLite at `prisma/data/dev.db` | MySQL via `REMOTE_MYSQL_*` env vars |
| **Config** | `.env.local` | Nacos (lazy-loaded on first API call) |

### 2.2 Startup Sequence

```
1. Next.js starts (dev or standalone)
   ↓
2. instrumentation.ts register() called
   ↓
3. if (NEXT_RUNTIME === 'nodejs' && IM_SERVER_ENABLED !== 'false')
   ↓
4. bootstrapIMServer()
   ├── Load Nacos config (production only)
   ├── Set DATABASE_URL (SQLite for dev, MySQL for prod)
   ├── createApp() → Hono app + services
   ├── Store app in globalThis.__imApp
   └── Store handlers in globalThis.__imHandlers
   ↓
5. IM Server ready (in-process, no port)
   ↓
6. Requests to /api/im/* routed to:
   /app/api/im/[...path]/route.ts
   └── getIMApp().fetch(request)
```

### 2.3 Request Flow

**Example: Send a message via API Key**

```
1. Client: POST /api/im/messages/{conversationId}
   Header: Authorization: Bearer sk-prismer-live-abc123...
   Body: { type: "text", content: "Hello" }
   ↓
2. Next.js route: /app/api/im/[...path]/route.ts
   ├── Extract auth header
   ├── Call apiGuard(request, { tier: 'tracked' })
   │   └── Validates API Key against users table
   │   └── Loads user info (id, email, agentIds)
   │   └── Generates IM JWT for user (cached 5min)
   │   └── Returns { ok: true, auth: { userId, authType: 'api_key', imToken } }
   ├── Replace auth header: Bearer {imToken}
   ├── Build Hono request with new auth
   ├── getIMApp().fetch(honoRequest) — IN-PROCESS CALL
   │   ↓
   │   ┌─────────────────────────────────────────────────┐
   │   │  IM Server (Hono app)                           │
   │   ├── JWT middleware: verify imToken                │
   │   ├── Extract userId from JWT                       │
   │   ├── MessageService.send()                         │
   │   │   ├── Check conversation membership             │
   │   │   ├── Insert message into im_messages           │
   │   │   ├── Publish to Redis (WebSocket broadcast)    │
   │   │   ├── WebhookService.dispatch() (fire-forget)   │
   │   │   └── Return { ok: true, data: message }        │
   │   └── Response: { ok: true, data: { id, ... } }     │
   │   └────────────────────────────────────────────────┘
   │   ↓
   └── Receive Hono response
   ├── recordIMUsage() (background)
   │   └── Insert into pc_usage_records, deduct pc_user_credits
   └── Return response to client
```

---

## 3. Database Architecture

### 3.1 Three-Namespace Coexistence

All tables live in the **same MySQL database** (`prismer_info` / `prismer_cloud`), but are managed by different systems:

| Namespace | Prefix | Managed By | Access Method |
|-----------|--------|-----------|---------------|
| **Backend** | (none) | Go backend API | HTTP API proxy |
| **Frontend-First** | `pc_` | Next.js local DB | MySQL2 direct SQL |
| **IM** | `im_` | IM server via Prisma | Prisma ORM (dual client) |

#### Backend Tables (no prefix)

```sql
users                -- Cloud user accounts (email, password, OAuth)
api_keys             -- API keys (sk-prismer-*)
context_cache        -- Content cache (HQCC + raw content)
```

**Access:** Next.js proxies to Go backend at `prismer.app/api/v1` or `prismer.services/api/v1`.

#### Frontend-First Tables (`pc_` prefix)

```sql
pc_usage_records          -- Usage history (task_id, type, credits, timestamps)
pc_user_credits           -- Credit balances per user (initial, used, remaining)
pc_payments               -- Payment transactions (Stripe)
pc_payment_methods        -- Saved payment methods
pc_subscriptions          -- (future) Subscription plans
```

**Access:** Direct SQL via `src/lib/db.ts` (MySQL2 connection pool).

**Feature Flags:** `FF_USAGE_RECORD_LOCAL`, `FF_ACTIVITIES_LOCAL`, etc. control whether to use local DB or proxy to backend.

#### IM Tables (`im_` prefix)

```sql
im_users                  -- IM user registry (username, role, imUserId=u_{uid})
im_conversations          -- Conversations (direct, group, channel)
im_participants           -- Conversation membership
im_messages               -- Message history
im_read_cursors           -- Read receipts per user+conversation
im_agents                 -- Agent capability cards (endpoint, heartbeat)
im_group_members          -- Group membership (M:N)
im_social_bindings        -- Social platform bindings (Telegram, Discord, Slack)
im_bridge_messages        -- Bridged message references
im_context_cache          -- (v1.6.0) Prisma-first context cache (replaces backend context_data)
im_file_uploads           -- (v1.7.0) File upload records (presign → confirm → CDN delivery)
im_sync_events            -- (v1.7.0) Sync events for offline-first SDK (cursor-based incremental sync)
im_credits                -- (dev only) IM-level credits (SQLite only, prod uses pc_user_credits via CloudCreditService)
im_credit_transactions    -- (dev only) IM credit history (SQLite only)

-- v1.7.2: Agent Intelligence Platform (9 new tables)
im_tasks                  -- (v1.7.2) Cloud Task Store (lifecycle, scheduling, retry)
im_task_logs              -- (v1.7.2) Task audit trail (created, assigned, started, progress, completed, failed)
im_identity_keys          -- (v1.7.2) Ed25519 identity keys (one per user, server-attested)
im_key_audit_log          -- (v1.7.2) Key operation audit (hash-chained, append-only)
im_conversation_security  -- (v1.7.2) Per-conversation signing policy + anti-replay state
im_compaction_summaries   -- (v1.7.2) Working Memory compaction summaries
im_memory_files           -- (v1.7.2) Episodic Memory (Markdown files, MEMORY.md pattern)
im_evolution_edges        -- (v1.7.2) Evolution memory graph (signal → gene → confidence)
im_evolution_capsules     -- (v1.7.2) Gene execution records (outcome, score, cost)
```

**Access:** Prisma client (dual schema: SQLite for dev, MySQL for prod).

**Prisma Setup:**

1. **Development:** `prisma/schema.prisma` → SQLite at `prisma/data/dev.db`
2. **Production:** `prisma/schema.mysql.prisma` → MySQL via `DATABASE_URL`
3. **Client selection:** `src/lib/prisma.ts` checks `DATABASE_URL` prefix (`mysql://` vs `file:`)

**Migrations:**

- **SQLite (dev):** `npx prisma db push` (schema-first, no migrations)
- **MySQL (prod):** Raw SQL scripts in `src/im/sql/001-011-*.sql` (applied manually)

### 3.2 Database Selection Logic

**For IM server:**

```typescript
// src/im/bootstrap.ts ensureDatabaseUrl()
if (DATABASE_URL already set) {
  use it
} else if (NODE_ENV !== 'production') {
  DATABASE_URL = file:prisma/data/dev.db  // SQLite
} else {
  DATABASE_URL = mysql://{user}:{pass}@{host}:{port}/{db}  // from REMOTE_MYSQL_* env vars
}
```

**For Frontend-First DB:**

```typescript
// src/lib/db.ts
const pool = mysql2.createPool({
  host: REMOTE_MYSQL_HOST,    // from Nacos config
  port: REMOTE_MYSQL_PORT,
  user: REMOTE_MYSQL_USER,
  password: REMOTE_MYSQL_PASSWORD,
  database: REMOTE_MYSQL_DATABASE,
});
```

### 3.3 Credit System Architecture

**Two implementations:**

| Environment | Table | Implementation |
|-------------|-------|----------------|
| **Dev (SQLite)** | `im_credits`, `im_credit_transactions` | LocalCreditService (IM-level, isolated) |
| **Test/Prod (MySQL)** | `pc_user_credits` | CloudCreditService (bridges to cloud credits) |

**CloudCreditService:**

- IM credits are **aliases** of cloud credits (same pool)
- `im_users.imUserId` is mapped to `users.id` via `im_users.cloudUserId`
- Deductions write to `pc_user_credits.credits_used`
- No separate IM credit transactions table (uses cloud usage history)

---

## 4. Authentication & Authorization

### 4.1 Dual Auth System

| Auth Type | Format | Storage | Validated By | Used For |
|-----------|--------|---------|-------------|----------|
| **API Key** | `sk-prismer-{env}-{64hex}` | `api_keys` table | `apiGuard()` → backend | Public APIs (Context, Parse) |
| **Cloud JWT** | JWT (exp 30d) | `localStorage.prismer_auth` | `apiGuard()` → backend | Dashboard, web UI |
| **IM JWT** | JWT (exp 7d) | Ephemeral (not stored) | IM server JWT middleware | IM operations |

### 4.2 Auth Flow for API Key Users

```
1. Client sends: Authorization: Bearer sk-prismer-live-abc123
   ↓
2. apiGuard(request)
   ├── Check cache: hashedKey → userInfo (5min TTL)
   ├── If miss: POST backend /cloud/keys/validate
   │   └── Returns { valid: true, user: {...}, agentIds: [...] }
   ├── Generate IM JWT:
   │   - Load im_users where cloudUserId = user.id
   │   - Sign JWT with claims: { userId: imUserId, username, role, exp }
   │   - Cache for 5min
   └── Return { ok: true, auth: { userId, authType: 'api_key', imToken } }
   ↓
3. IM route replaces header: Bearer {imToken}
   ↓
4. IM server validates imToken (HS256)
   └── Decodes userId = u_abc123, proceeds
```

### 4.3 Multi-Agent Identity

**Problem:** One human may own multiple agents (e.g., `CodeBot`, `DataBot`). Which agent is "speaking"?

**Solution:** `X-IM-Agent` header

```
POST /api/im/messages/{conversationId}
Authorization: Bearer sk-prismer-live-...
X-IM-Agent: u_abc789   (imUserId of desired agent)
Content-Type: application/json

{ "type": "text", "content": "Hello from CodeBot" }
```

**Validation:**

```typescript
// IM server JWT middleware
const requestedAgentId = ctx.req.header('X-IM-Agent');
if (requestedAgentId) {
  // Check if user owns this agent
  if (!user.agentIds.includes(requestedAgentId)) {
    return 403 Forbidden
  }
  ctx.set('effectiveUserId', requestedAgentId);  // Override
} else {
  ctx.set('effectiveUserId', user.id);  // Default
}
```

---

## 5. API Layer Design

### 5.1 API Route Categories

**Orchestration** (multi-step business logic):

- `/api/context/load` — Input detection → cache withdraw → Exa search → OpenAI compress → cache deposit → usage record
- `/api/parse` — Parser service call → usage record → async job tracking

**Direct External** (thin wrappers):

- `/api/search` → Exa
- `/api/content` → Exa (with livecrawl fallback)
- `/api/compress` → OpenAI

**Backend Proxy** (forward to Go backend):

- `/api/auth/*` → backend `/auth/*`

**Feature-Flag Switchable** (local DB or backend):

- `/api/context/save` — `FF_CONTEXT_CACHE_LOCAL ? context-cache.service.ts : backend`
- `/api/keys/*` — `FF_API_KEYS_LOCAL ? pc_api_keys : backend`
- `/api/usage/record` — `FF_USAGE_RECORD_LOCAL ? db-usage.ts : backend`
- `/api/activities` — same pattern
- `/api/dashboard/stats` — same pattern
- `/api/billing/*` — `FF_BILLING_LOCAL ? db-billing.ts + Stripe : backend`

**IM (in-process Hono):**

- `/api/im/*` → `getIMApp().fetch(request)` (43 REST endpoints + WebSocket + SSE)

### 5.2 Load API Architecture (Context Orchestration)

**Most complex route — 3 modes, 800+ lines**

```
Input: { input: "...", processing: {...}, return: {...}, ranking: {...} }
  ↓
┌─ Input Detection ─────────────────────────────────────────┐
│ - single_url: "https://example.com"                       │
│ - batch_urls: ["url1", "url2", ...]                       │
│ - query: "latest AI news"                                 │
└────────────────────────────────────────────────────────────┘
  ↓
┌─ Single URL Flow ──────────────────────────────────────────┐
│ 1. withdraw({ url, format: 'hqcc' }, userId)                │
│    ├─ [FF=true] Prisma local cache HIT → return (~5ms)      │
│    │  └─ MISS → backend fallback HIT → return (~167ms)      │
│    │           (warm migration + background write-back)      │
│    └─ [FF=false] backend proxy (~200ms)                     │
│    └─ if (found && hqcc_content) → return cached            │
│ --- true cache miss: both local + backend MISS ---          │
│ 2. fetch /api/content → Exa getContents (~1-3s)            │
│ 3. fetch /api/compress → OpenAI LLM (~2-10s)               │
│ 4. deposit({ url, hqcc, visibility: 'public' }, userId)    │
│    └─ [FF=true] Prisma write + background backend dual-write│
│ 5. recordUsageBackground()                                 │
│ Total true miss: ~3-15s (Exa + LLM dominated)              │
└────────────────────────────────────────────────────────────┘
  ↓
┌─ Batch URL Flow ───────────────────────────────────────────┐
│ 1. withdrawBatch({ urls, format: 'hqcc' }, userId)          │
│    ├─ [FF=true] Single Prisma findMany WHERE IN (~26ms)    │
│    └─ [FF=false] Parallel single withdraws                 │
│    └─ Split: cached vs uncached                            │
│ 2. if (processUncached) → fetch uncached → compress → deposit │
│ 3. Return all results with cached flags                    │
└────────────────────────────────────────────────────────────┘
  ↓
┌─ Query Flow ───────────────────────────────────────────────┐
│ 1. fetch /api/search → Exa searchAndContents (topK=10)     │
│ 2. withdrawBatch(urls)                                     │
│ 3. Compress uncached results (maxConcurrent=3)             │
│ 4. Rank results (cache_first | relevance_first | balanced) │
│ 5. Return top N with ranking scores                        │
└────────────────────────────────────────────────────────────┘
```

**Ranking System:**

| Preset | Behavior |
|--------|----------|
| `cache_first` | Cached items always ranked first, then by relevance |
| `relevance_first` | Pure Exa score ranking, ignore cache status |
| `balanced` | Cache boost (+0.2 score) but doesn't dominate |

### 5.3 Context API Adapter (v1.6.0 — Local Cache First)

**Problem:** Backend context cache has multiple bugs (batch broken, user_id=0, format case sensitivity).

**Solution:** `src/lib/context-api.ts` — Feature-flag-controlled adapter with local Prisma cache as primary path.

**Data flow (`FF_CONTEXT_CACHE_LOCAL=true`):**

```
withdraw(request, authHeader, userId)
  ├─ Local Prisma cache → HIT (~5ms) → return
  └─ MISS → backend fallback → HIT → return + background write-back (warm migration)
                              └─ MISS → return not found

deposit(request, authHeader, userId)
  ├─ Local Prisma write (sync, ~20ms)
  └─ Backend dual-write (background, fire-and-forget)

withdrawBatch(urls, authHeader, userId)
  └─ Single Prisma findMany with WHERE IN (~26ms for 10 URLs)
```

**Key service:** `src/lib/context-cache.service.ts` — `ContextCacheService` class with deposit, withdraw, withdrawBatch, delete. SHA-256 dedup via `rawLinkHash` unique index. 100MB content size gate. Visibility enforcement (public/private/unlisted).

**Performance (measured 2026-02-16, test env):**

| Operation | Server-side latency |
|-----------|-------------------|
| Single URL cache hit | ~5ms |
| Batch 10 URLs cache hit | ~26ms |
| Deposit (save) | ~20ms |
| Save → Load round-trip | ~32ms |
| Warm migration (local miss → backend hit) | ~167ms |
| True cache miss (Exa fetch + LLM compress) | ~3-15s |

**See:** `docs/BACKEND-REQUIREMENTS.md` for backend API spec vs reality comparison.

---

## 6. IM Server Integration

### 6.1 No Separate Port — In-Process Design

**Traditional approach (what we DON'T do):**

```
┌──────────────┐         HTTP        ┌──────────────┐
│  Next.js     │ ──────────────────> │  IM Server   │
│  port 3000   │ <────────────────── │  port 3200   │
└──────────────┘                      └──────────────┘
     │                                       │
     └───────── Network latency ─────────────┘
```

**Our approach:**

```
┌────────────────────────────────────────────┐
│  Single Process (port 3000)                │
│  ┌──────────────┐    function call         │
│  │  Next.js     │ ────────────────────>    │
│  │  route.ts    │                    ┌─────▼───────┐
│  └──────────────┘ <──────────────────│ Hono app    │
│                     in-process        │ (globalThis)│
│                                       └─────────────┘
└────────────────────────────────────────────┘
```

**Benefits:**

1. **Zero latency** — No TCP, no serialization
2. **Unified auth** — apiGuard converts API Key → IM JWT seamlessly
3. **Single deploy** — One Docker container, one K8s pod
4. **Shared resources** — One Redis, one MySQL pool, one Nacos config

### 6.2 WebSocket Architecture

**Development mode:**

```typescript
// src/im/bootstrap.ts
import { Server as WebSocketServer } from 'ws';
const wss = new WebSocketServer({ port: 3001 });  // Separate WS port
```

**Production mode (standalone Next.js):**

```typescript
// server.ts (custom server, replaces `next start`)
import { createServer } from 'http';
import next from 'next';
const app = next({ dev: false });
const server = createServer(app.getRequestHandler());

server.on('upgrade', (req, socket, head) => {
  const { setupWebSocket } = getIMHandlers();
  setupWebSocket(req, socket, head);
});

server.listen(3000);  // Single port for HTTP + WS
```

**Client connects:**

```javascript
const ws = new WebSocket('ws://localhost:3000/ws?token=JWT_TOKEN');
```

**Message flow:**

```
1. Client sends WebSocket upgrade request
   ↓
2. server.on('upgrade')
   ├── Parse token from query string
   ├── Validate JWT
   ├── Call getIMHandlers().setupWebSocket(req, socket, head)
   │   └── IM server ws handler takes over
   ├── Store { userId, socket } in RoomManager
   └── Subscribe to Redis pub/sub: im:events:{userId}
   ↓
3. When message sent via REST API (v1.7.1+):
   MessageService.send()
   ├── Insert into im_messages
   ├── SyncService.writeEvent('message.new', ...)
   ├── For each participant:
   │   └── rooms.sendToUser(userId, event)
   │       ├── Local: deliver to all connections of this user
   │       └── Redis: publish to im:broadcast channel
   │           └── Other Pods receive → localSendToUser()
   └── Return message + routing info

4. When message sent via WebSocket:
   ws handler (message.send)
   ├── MessageService.send()
   └── rooms.broadcastToRoom(conversationId, event, excludeSender)
```

### 6.3 Webhook Dispatch System

**Feature:** When a message is sent to a conversation with agent endpoints, IM server POSTs webhook to the agent's URL.

**Flow:**

```
1. POST /api/im/messages/{conversationId}
   ↓
2. MessageService.send()
   ├── Insert message
   ├── rooms.sendToUser() per participant (local + Redis cross-pod)
   ├── WebhookService.dispatch() — fire-and-forget
   │   ├── Find all participants with role='agent' && endpoint != null
   │   ├── Exclude sender
   │   ├── Build WebhookPayload { source, event, timestamp, message, sender, conversation }
   │   └── For each agent:
   │       ├── Sign payload with HMAC-SHA256
   │       ├── POST to agent endpoint with headers:
   │       │   - X-Prismer-Signature: sha256={hex}
   │       │   - X-Prismer-Event: message.new
   │       │   - User-Agent: Prismer-IM/0.3.0
   │       └── Retry 3 times (2s, 5s) on failure
   └── Return { ok: true, data: message }
```

**Webhook payload:**

```json
{
  "source": "prismer_im",
  "event": "message.new",
  "timestamp": 1770201234567,
  "message": {
    "id": "msg_abc123",
    "type": "text",
    "content": "Hello",
    "senderId": "u_xyz789",
    "conversationId": "conv_abc",
    "parentId": null,
    "metadata": {},
    "createdAt": "2026-02-15T12:00:00Z"
  },
  "sender": {
    "id": "u_xyz789",
    "username": "user_123",
    "displayName": "John Doe",
    "role": "user"
  },
  "conversation": {
    "id": "conv_abc",
    "type": "direct",
    "title": null
  }
}
```

**Signature verification (agent side):**

```typescript
import crypto from 'crypto';

const signature = request.headers['x-prismer-signature'];  // "sha256=abc123..."
const body = await request.text();
const secret = process.env.WEBHOOK_SECRET;

const expectedSig = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

if (signature !== expectedSig) {
  return 401;  // Invalid signature
}

const payload = JSON.parse(body);
// Process webhook...
```

**Agent registration with webhook:**

```json
POST /api/im/agents/register
Authorization: Bearer {agent_jwt}

{
  "capabilities": ["chat", "code-review"],
  "endpoint": "https://my-agent.example.com/webhook",
  "metadata": {
    "webhookSecret": "my-secret-key-12345"
  }
}
```

**Secret resolution:**

1. Try `agent.metadata.webhookSecret` (per-agent)
2. Fallback to `config.webhook.secret` (global default from env `WEBHOOK_SECRET`)

### 6.4 File Transfer Architecture (v1.7.0)

**Two-phase upload with server-side content validation:**

```
┌──────────┐    POST /files/presign    ┌──────────────┐
│  Client   │─────────────────────────>│  IM Server    │
│           │<─────────────────────────│  FileService   │
│           │  { uploadId, url, fields }│              │
│           │                          └──────────────┘
│           │                                │
│           │    POST S3 (presigned)         │ creates IMFileUpload
│           │──────────────────────>  ┌─────▼────────┐
│           │<──────────────────────  │  S3 Bucket    │
│           │  204 (upload complete)  │  pro-prismer- │
│           │                         │  slide        │
│           │    POST /files/confirm   └──────────────┘
│           │─────────────────────────>│  IM Server    │
│           │                          │  1. S3 HEAD   │
│           │                          │  2. GET 8KB   │
│           │                          │  3. Validate: │
│           │                          │   - magic bytes│
│           │                          │   - MIME check │
│           │                          │   - exec scan │
│           │                          │   - bomb check│
│           │<─────────────────────────│  4. CDN URL   │
│           │  { cdnUrl, cost }        └──────────────┘
│           │                                │
│           │    POST /messages/{id}         │ deducts credits
│           │  type: "file"                  │
│           │  metadata: { fileUrl, ... }    ▼
│           │─────────────────>  ┌──────────────────┐
│           │                    │  CDN              │
│           │                    │  cdn.prismer.app  │
└──────────┘                    └──────────────────┘
```

**Key components:**

| File | Purpose |
|------|---------|
| `src/im/services/file.service.ts` | Core business logic (presign, confirm, delete, quota, cleanup) |
| `src/im/services/file-validator.ts` | Content validation pipeline (magic bytes, exec scan, bomb check) |
| `src/im/services/s3.client.ts` | Singleton S3 client wrapper |
| `src/im/api/files.ts` | Hono router (7 endpoints) |

**Dev mode:** When `config.s3.accessKeyId` is empty, FileService falls back to local filesystem (`prisma/data/uploads/`) with dev-only upload/download endpoints. Full presign → upload → confirm flow works locally without AWS.

**Content validation pipeline (runs on S3 object after upload):**

1. Extension blocklist (`.exe`, `.dll`, `.sh`, `.js`, `.html`, `.svg`, etc.)
2. Magic bytes detection via `file-type` (real MIME from binary header)
3. MIME whitelist check
4. MIME mismatch detection (declared vs actual)
5. Executable signature scan (PE `MZ`, ELF `\x7fELF`, Mach-O)
6. Compression bomb detection (ratio < 100x)
7. Size consistency (declared vs actual S3 object size)

### 6.5 Offline Sync Architecture (v1.7.0)

**Problem:** SDK clients need offline-first messaging — send messages while offline, sync when reconnected.

**Solution:** Cursor-based incremental sync with outbox queue pattern and SSE real-time push.

**Server-side components:**

```
┌──────────────────────────────────────────────────────────────────┐
│  IM Server                                                       │
│                                                                  │
│  MessageService ──┐                                              │
│  (send/edit/del)  │  writeEvent()                                │
│                   ├──────────────> SyncService ──> im_sync_events│
│  ConversationSvc ─┘                   │                          │
│  (create/update/                      │ publishEvent()           │
│   archive/add/                        │                          │
│   remove)                             ▼                          │
│                                   Redis pub/sub                  │
│                                   im:sync:{userId}               │
│                                       │                          │
│  ┌────────────────────────────────────┼──────────────────────┐   │
│  │                                    ▼                      │   │
│  │  GET /api/im/sync       GET /api/im/sync/stream          │   │
│  │  (polling)              (SSE continuous push)             │   │
│  │  ├─ auth: JWT header    ├─ auth: ?token= query param     │   │
│  │  ├─ ?since=cursor       ├─ Phase 1: catch-up from cursor │   │
│  │  └─ returns events[]    ├─ Phase 2: Redis subscribe      │   │
│  │                         └─ Heartbeat every 25s            │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

**Sync event flow (example: group creation):**

```
1. User A calls POST /api/im/groups { title: "Team", members: [B, C] }
   ↓
2. ConversationService.createGroup()
   ├─ convModel.create() → im_conversations
   ├─ participantModel.add() × 3 (A, B, C)
   └─ writeSyncForParticipants('conversation.create', data, convId, [A, B, C])
       ├─ syncService.writeEvent() for user A → im_sync_events row
       ├─ syncService.writeEvent() for user B → im_sync_events row
       └─ syncService.writeEvent() for user C → im_sync_events row
           └─ Each also publishes to Redis: im:sync:{userId}
   ↓
3. SSE clients connected for A, B, C each receive the event in real-time
4. Polling clients receive on next GET /api/im/sync?since={cursor}
```

**Key design decisions:**

1. **Events per participant:** Each sync event is written once per participant. This enables per-user cursor tracking and access control without JOIN queries.
2. **Remove before delete:** `participant.remove` writes sync events BEFORE removing the participant from `im_participants`, so the removed user still receives the event.
3. **Dual sync modes:** SSE (push) is the default for real-time UX. Polling is the fallback for environments without SSE support.
4. **Idempotency:** Message sends include `_idempotencyKey` in metadata. Server deduplicates within 24h window — safe for outbox retries.

**Client-side (SDK) architecture:**

```
┌─────────────────────────────────────────────────┐
│  OfflineManager                                  │
│                                                  │
│  ┌──────────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Outbox Queue │  │ Sync     │  │ Read      │  │
│  │              │  │ Engine   │  │ Cache     │  │
│  │ Write ops    │  │          │  │           │  │
│  │ queued with  │  │ Push:SSE │  │ Local-    │  │
│  │ idempotency  │  │ Poll:GET │  │ first     │  │
│  │ key, auto-   │  │          │  │ reads     │  │
│  │ flushed      │  │ Apply    │  │           │  │
│  │ when online  │  │ events   │  │           │  │
│  └──────────────┘  └──────────┘  └───────────┘  │
│                                                  │
│  Storage: MemoryStorage / IndexedDB / SQLite     │
└──────────────────────────────────────────────────┘
```

**Database schema:**

```sql
-- im_sync_events (cursor = auto-increment id)
CREATE TABLE im_sync_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(50) NOT NULL,          -- e.g., "message.new", "conversation.create"
  data TEXT NOT NULL DEFAULT '{}',    -- JSON event payload
  conversationId VARCHAR(30) NULL,
  imUserId VARCHAR(30) NOT NULL,      -- target user
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
```

### 6.6 OpenClaw Integration (SDK v0.2.0)

**Problem:** Agents backed by OpenClaw need to receive Prismer IM messages and respond automatically.

**Solution:** SDK bridge module that transforms Prismer IM webhooks into OpenClaw `/hooks/agent` calls, with auto-reply back to the IM conversation.

**Data flow:**

```
┌───────────────────────────────────────────────────────────────────────┐
│  Prismer Cloud                                                        │
│  ┌────────────────────┐    webhook POST     ┌──────────────────────┐ │
│  │  IM Server          │──────────────────── │  SDK (Agent Server)  │ │
│  │  WebhookService     │                     │  PrismerWebhook      │ │
│  │  .dispatch()        │                     │  .verify() → .parse()│ │
│  │                     │  auto-reply POST    │                      │ │
│  │  MessageService     │◄─────────────────── │  OpenClawBridge      │ │
│  │  .send()            │                     │  .forward()          │ │
│  └────────────────────┘                     └───────────┬──────────┘ │
└───────────────────────────────────────────────────────────┼───────────┘
                                                            │
                                              POST /hooks/agent
                                                            │
                                                ┌───────────▼──────────┐
                                                │  OpenClaw Gateway    │
                                                │  - JWT auth          │
                                                │  - Agent runner      │
                                                │  - Session context   │
                                                │  - Tool execution    │
                                                └──────────────────────┘
```

**Payload mapping:**

| Prismer webhook field | OpenClaw `/hooks/agent` field |
|----------------------|------------------------------|
| `message.content` | `message` |
| `sender.displayName` | `name` |
| `conversation.id` | `sessionKey` (prefixed: `hook:prismer:{id}`) |
| — | `agentId` (config) |
| — | `deliver: false` (SDK handles reply) |
| — | `wakeMode: "now"` |

**Session continuity:** Each Prismer conversation maps to a unique OpenClaw `sessionKey`, preserving context across messages. Pattern: `hook:prismer:{conversationId}`.

**Key design decisions:**

1. **`deliver: false`** — OpenClaw should NOT deliver via its own channels (WhatsApp, Telegram, etc.). The SDK handles reply via Prismer IM.
2. **No server-side changes** — Everything runs in the SDK (agent's server). Prismer Cloud and OpenClaw are unmodified.
3. **HMAC verification** — SDK verifies `X-Prismer-Signature` before forwarding to OpenClaw.
4. **Fire-and-forget from Prismer's perspective** — Prismer IM webhook dispatch doesn't wait for OpenClaw response. The auto-reply is a separate POST back.

### 6.6 Agent Intelligence Platform (v1.7.2)

v1.7.2 adds four pillars to the IM server, totaling 31 new endpoints and 9 new tables.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Agent Intelligence Platform (v1.7.2)                               │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────┐   │
│  │ P1: Task         │  │ P2: E2E Signing  │  │ P3: Memory     │   │
│  │ Orchestration    │  │ Hardening        │  │ Layer          │   │
│  │                  │  │                  │  │                │   │
│  │ im_tasks         │  │ im_identity_keys │  │ im_memory_files│   │
│  │ im_task_logs     │  │ im_key_audit_log │  │ im_compaction_ │   │
│  │                  │  │ im_conversation_ │  │  summaries     │   │
│  │ 8 endpoints      │  │  security        │  │                │   │
│  │ Scheduler (10s)  │  │ 6 endpoints      │  │ 8 endpoints    │   │
│  │ Retry + backoff  │  │ Ed25519 strict   │  │ MEMORY.md      │   │
│  │ 42 tests         │  │ Anti-replay      │  │ 30 tests       │   │
│  │                  │  │ 29 tests         │  │                │   │
│  └───────┬──────────┘  └──────────────────┘  └────────────────┘   │
│          │                                                         │
│  ┌───────▼──────────────────────────────────────────────────────┐  │
│  │ P4: Skill Evolution                                          │  │
│  │ im_evolution_edges + im_evolution_capsules                   │  │
│  │ Gene selection (Jaccard + Laplace + drift) → Outcome record  │  │
│  │ → Personality adaptation → LLM distillation                  │  │
│  │ Task lifecycle hook: completeTask/failTask → auto-record     │  │
│  │ 9 endpoints, 47 tests                                        │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Total: 31 endpoints, 9 tables, 148 tests                          │
└─────────────────────────────────────────────────────────────────────┘
```

**Key design decisions:**

1. **Task state machine:** `pending → assigned → running → completed/failed/cancelled`. Optimistic concurrency (Prisma `update where status=X`) for multi-Pod safety.
2. **Memory: server returns full content.** Truncation (200 lines) is SDK/Agent responsibility. Server provides `totalLines`/`totalBytes` metadata.
3. **Ed25519 Strict RFC 8032.** Rejects non-canonical S values. Sliding window anti-replay (64-bit, IPsec RFC 4303). 5-minute clock skew tolerance.
4. **Evolution genes stored in IMAgentCard.metadata** (JSON). No separate table — genes are agent-owned, stored alongside personality and stats.
5. **LLM distillation uses OpenAI-compatible API** (env: `OPENAI_API_KEY`). Retry with exponential backoff. Deduplication via >80% Jaccard signal overlap.

**Services:**

| Service | File | Lines | Responsibility |
|---------|------|-------|---------------|
| `TaskService` | `services/task.service.ts` | ~830 | CRUD, lifecycle, scheduler, retry, evolution hook |
| `MemoryService` | `services/memory.service.ts` | ~395 | Memory files CRUD, compaction, session load |
| `EvolutionService` | `services/evolution.service.ts` | ~950 | Signals, genes, selection, recording, personality, distillation |
| `IdentityService` | `services/identity.service.ts` | ~310 | Key registration/rotation/revocation, attestation, audit chain |
| `SigningService` | `services/signing.service.ts` | ~200 | Message verification, anti-replay, sequence management |

**SQL migrations:** `src/im/sql/008-011`

---

## 7. External Services

| Service | Purpose | Used By | Auth |
|---------|---------|---------|------|
| **Exa Search** | Web search + content extraction | `/api/search`, `/api/content`, Load API query mode | API Key (env `EXA_API_KEY`) |
| **OpenAI** | LLM-based content compression | `/api/compress`, Load API | API Key (env `OPENAI_API_KEY`) |
| **Parser** | OCR for PDF/images | `/api/parse` | None (internal service) |
| **Stripe** | Payment processing | `/api/billing/*` (when `FF_BILLING_LOCAL=true`) | Secret key (env `STRIPE_SECRET_KEY`) |
| **Backend API** | User auth, context cache, API keys | Most proxied routes | None (internal, auth via header forwarding) |
| **Nacos** | Configuration center | All production deploys | Username/password (env `NACOS_USERNAME`, `NACOS_PASSWORD`) |
| **Redis** | IM pub/sub, real-time broadcast (cross-pod) | IM server | URL (built from `REDIS_HOST`/`REDIS_URL` etc.) |
| **AWS S3** | File upload storage | IM FileService | Access key (env `AWS_S3_ACCESS_KEY_ID`) |
| **CloudFront CDN** | File delivery (`cdn.prismer.app`) | IM FileService | Domain (env `CDN_DOMAIN`) |

### 7.1 Exa Integration

**Two modes:**

1. **Search** (`searchAndContents`) — Query → URLs + metadata + content
2. **Content** (`getContents`) — URLs → content extraction

**Content fetch fallback:**

```typescript
// /api/content
1. Try Exa getContents(urls)
2. If any URL fails:
   └─ Retry with livecrawl: true (slower, JavaScript rendering)
```

### 7.2 OpenAI Integration

**Compression strategies:**

| Strategy | Model | System Prompt |
|----------|-------|---------------|
| `aggressive` | gpt-4o-mini | "Compress to 20% of original, keep key facts" |
| `balanced` | gpt-4o-mini | "Compress to 40%, preserve structure" |
| `preserve` | gpt-4o | "Minimal compression, keep all details" |
| `auto` | gpt-4o-mini | Adaptive based on content length |

**Streaming support:**

```
GET /api/compress?stream=true
→ Server-Sent Events (SSE)
→ Progressive chunks as LLM generates
```

---

## 8. Configuration Management

### 8.1 Nacos HTTP API (Not npm Package)

**Why HTTP API?**

- Nacos npm package only supports Nacos 1.x
- Our server runs Nacos 2.4.3
- HTTP API is version-agnostic

**Configuration:**

```typescript
// src/lib/nacos-config.ts
// Configure via environment variables:
// CONFIG_CENTER_IP, NACOS_USERNAME, NACOS_PASSWORD, NACOS_NAMESPACE
// Or set NACOS_DISABLED=true to skip Nacos entirely (self-host mode)
```

const namespace = namespaceMap[APP_ENV];
const dataId = 'PrismerCloud';
const group = 'DEFAULT_GROUP';
```

**Lazy loading:**

```typescript
// Config is NOT loaded at startup
// First API call triggers: await ensureNacosConfig()
// Then: process.env.REMOTE_MYSQL_* etc. are set
```

**Priority:**

```
process.env (explicit) > Nacos > defaults
```

### 8.2 Environment Variables

**Critical vars (must set):**

```bash
# Deployment context
APP_ENV=prod|test|dev           # Determines Nacos namespace + K8s namespace

# External APIs
EXA_API_KEY=...                 # Exa search API key
OPENAI_API_KEY=...              # OpenAI API key
PARSER_ENDPOINT=https://parser.prismer.dev

# Database (set by Nacos, or manual for dev)
REMOTE_MYSQL_HOST=...
REMOTE_MYSQL_PORT=3306
REMOTE_MYSQL_USER=admin
REMOTE_MYSQL_PASSWORD=...
REMOTE_MYSQL_DATABASE=prismer_info

# IM Server
IM_SERVER_ENABLED=true          # Set to false to disable IM server
DATABASE_URL=...                # Prisma (auto-set by bootstrap.ts)
REDIS_URL=redis://localhost:6379
JWT_SECRET=...                  # IM JWT signing key
WEBHOOK_SECRET=...              # Default webhook HMAC secret

# Feature Flags
FF_USAGE_RECORD_LOCAL=true
FF_ACTIVITIES_LOCAL=true
FF_DASHBOARD_STATS_LOCAL=true
FF_USER_CREDITS_LOCAL=true
FF_BILLING_LOCAL=true
```

---

## 9. Deployment Architecture

### 9.1 GitLab CI Tag-Based Triggers

| Tag Pattern | Build Env | Deploy Target | APP_ENV | Nacos Namespace |
|-------------|-----------|---------------|---------|-----------------|
| `dev-YYYYMMDD-vX.Y.Z` | — | Docker → dev host | `dev` | dev namespace |
| `test-YYYYMMDD-vX.Y.Z` | `BUILD_ENV=test` | Docker → prismer.dev | `test` | test namespace |
| `k8s-test-YYYYMMDD-vX.Y.Z` | `BUILD_ENV=test` | K8s → EKS test | `test` | test namespace |
| `prod-YYYYMMDD-vX.Y.Z` | `BUILD_ENV=prod` | Docker + K8s prod | `prod` | prod namespace |
| `k8s-prod-YYYYMMDD-vX.Y.Z` | `BUILD_ENV=prod` | K8s → EKS prod | `prod` | prod namespace |

**`APP_ENV` is injected at deploy time:**

```bash
docker run -e APP_ENV=prod prismer-cloud:latest
```

### 9.2 Docker Build

```dockerfile
# Multi-stage build
FROM node:20-alpine AS deps
# Install dependencies

FROM node:20-alpine AS builder
# Copy deps, run prisma generate (both SQLite + MySQL clients), next build

FROM node:20-alpine AS runner
# Copy standalone output, Prisma clients, start server.ts
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.ts"]
```

**Key points:**

1. **Standalone output** (`output: 'standalone'`) — Includes all dependencies
2. **Dual Prisma clients** — Both SQLite and MySQL clients are bundled (runtime selects via `DATABASE_URL`)
3. **Custom server** (`server.ts`) — Handles WebSocket upgrade for production
4. **Single port** — HTTP + WebSocket on 3000

### 9.3 Kubernetes Deployment

**Namespace = `APP_ENV`:**

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: prod  # or test, dev

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prismer-cloud
  namespace: prod
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: app
        image: prismer-cloud:k8s-prod-20260215-v2.1.0
        env:
        - name: APP_ENV
          value: "prod"
        - name: NODE_ENV
          value: "production"
        ports:
        - containerPort: 3000
        livenessProbe:
          httpGet:
            path: /api/health
            port: 3000
        readinessProbe:
          httpGet:
            path: /api/health
            port: 3000
```

**Service + Ingress:**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: prismer-cloud
  namespace: prod
spec:
  selector:
    app: prismer-cloud
  ports:
  - port: 80
    targetPort: 3000

---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: prismer-cloud
  namespace: prod
spec:
  rules:
  - host: prismer.cloud
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: prismer-cloud
            port:
              number: 80
```

---

## 10. Testing Strategy

### 10.1 No Automated Test Framework

**Current approach:** Custom test runners (no framework)

```bash
# Integration tests (remote environments)
npx tsx scripts/test-all-apis.ts --env test   # 49 tests against cloud.prismer.dev
npx tsx scripts/test-all-apis.ts --env prod   # 49 tests against prismer.cloud

# IM Server tests (standalone mode, localhost:3200)
npx tsx src/im/tests/comprehensive.test.ts      # 109 tests
npx tsx src/im/tests/v030-integration.test.ts   # 42 tests
npx tsx src/im/tests/agent-lifecycle.test.ts    # 35 tests
npx tsx src/im/tests/webhook.test.ts            # 15 tests
npx tsx src/im/tests/sync-offline.test.ts       # 18 tests (sync events, cursor, idempotency)
npx tsx src/im/tests/conversation-sync.test.ts  # 13 tests (conversation sync events, SSE stream)

# File upload unit tests (runs against SQLite dev.db + local filesystem)
npx tsx src/im/tests/file-upload.test.ts                                                    # 54 tests

# Context Cache unit tests (runs against SQLite dev.db)
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/tests/context-cache.test.ts  # 20 tests

# v1.7.2 Agent Intelligence tests (runs against SQLite dev.db)
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/tests/task-orchestration.test.ts  # 42 tests
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/tests/e2e-encryption.test.ts      # 29 tests
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/tests/memory.test.ts              # 30 tests
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/tests/evolution.test.ts            # 47 tests

# IM scenario tests (remote environments)
API_KEY=sk-prismer-live-xxx BASE_URL=https://cloud.prismer.dev node scripts/test-im-scenarios.js  # 48 tests

# Performance benchmark
API_KEY=sk-prismer-live-xxx node scripts/test-performance.js  # Latency benchmarks
```

**Latest test results (2026-03-09, v1.7.2):**
- Cloud API integration: **45/45 pass** (API Key-based regression)
- File upload unit tests: **54/54 pass** (presign, upload, confirm, quota, delete, security, multipart)
- IM scenario tests: **48/48 pass** (agent lifecycle, groups, credits, edge cases)
- IM comprehensive: **108/109 pass** (1 pre-existing username edge case)
- Sync offline tests: **18/18 pass** (sync events, cursor, idempotency, edit/delete, access control)
- Conversation sync tests: **13/13 pass** (conversation.create, participant.add/remove, update, archive, SSE stream)
- Context Cache unit tests: **20/20 pass** (deposit, withdraw, batch, visibility, 100MB gate)
- WebSocket/SSE: **7/8 pass** (WS connect/auth/ping, SSE all OK)
- Webhook regression: **9/9 pass** (delivery, HMAC, self-send exclusion, multiple deliveries)
- **v1.7.2 Task Orchestration: 42/42 pass** (CRUD, ownership, lifecycle, scheduler, validation)
- **v1.7.2 E2E Encryption: 29/29 pass** (identity, signing, anti-replay, revocation, groups)
- **v1.7.2 Memory Layer: 30/30 pass** (files CRUD, compaction, auto-load, ownership isolation)
- **v1.7.2 Skill Evolution: 47/47 pass** (signals, genes, selection, recording, personality, distillation)

### 10.2 Test Environment Setup

**IM tests (standalone mode — recommended for local dev):**

```bash
# 1. Ensure SQLite dev database exists
mkdir -p prisma/data
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx prisma db push

# 2. Start standalone IM server (port 3200)
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/start.ts

# 3. Run tests (default BASE URL: http://localhost:3200)
npx tsx src/im/tests/webhook.test.ts
npx tsx src/im/tests/comprehensive.test.ts
```

**IM tests (via Next.js dev server):**

1. Start dev server: `npm run dev` (IM server auto-starts via `instrumentation.ts`)
2. Run tests with Next.js proxy URL: `IM_BASE_URL=http://localhost:3000/api/im npx tsx src/im/tests/*.test.ts`
3. Tests hit `http://localhost:3000/api/im/*`

**Cloud API tests:**

```bash
# Test environment
export BASE_URL=https://cloud.prismer.dev
export PRISMER_API_KEY=sk-prismer-live-...

# Production
export BASE_URL=https://prismer.cloud
export PRISMER_API_KEY=sk-prismer-live-...

npx tsx scripts/test-all-apis.ts
```

### 10.3 Multi-Environment Test Script

**`scripts/test-all-apis.ts`** — Runs against local, test, and prod:

```bash
npm run test:all:local  # → http://localhost:3000
npm run test:all:test   # → https://cloud.prismer.dev
npm run test:all:prod   # → https://prismer.cloud
```

**Test groups (49 tests):**

1. Config/Version (3) — version, OAuth config, docs endpoint
2. Auth (3+1skip) — API key, invalid key, missing auth, login (local only)
3. Context API (6) — load single/batch/query, save, cache hit, schema
4. Parse API (4) — fast mode, schema, history, pricing
5. IM Proxy (23) — health, workspace init, messages, conversations, discover, me, contacts, format + 13 file upload tests (presign, S3 upload lifecycle, confirm, CDN URL, file message, quota, delete)
6. Usage/Analytics (3) — activities, dashboard stats, pagination
7. Billing (3) — payment methods, invoices, topup
8. API Keys (3) — list, create, delete

---

## 11. Evolution Redesign Architecture

> Detailed design: [`docs/EVOLUTION-REDESIGN.md`](./EVOLUTION-REDESIGN.md) | Status: 🚧 Frontend in progress

### 11.1 Information Architecture

The `/evolution` page is redesigned from a single gene card list into a **5-tab information architecture**:

```
[Overview]  [Skills]  [Genes]  [Timeline]  [Agents]
    │          │         │         │           │
    │          │         │         │           └─ Agent contribution leaderboard
    │          │         │         └─ Vertical timeline + milestone detection
    │          │         └─ Gene Library (success rate bar, attribution, fork)
    │          └─ 5,455 Skill Catalog (search/filter/paginate)
    └─ KPI + Canvas animation (Signal→Gene→Outcome) + education
```

**User journeys:**
- **Newcomer:** Overview (learn concept) → Skills (browse capabilities) → "I want an agent"
- **Developer:** Skills (search specific tool) → Genes (best practices) → Install
- **Contributor:** Timeline (latest events) → Agents (my rank) → Publish Gene
- **Decision maker:** Overview (global data) → Agents (who's active) → "Worth investing"

### 11.2 Rendering Architecture

**Overview Tab — Canvas Visualization:**

```
Signal ──→ Gene ──→ Outcome
  ⚡         🧬        ✓/✗       ← Three-column node network
  │          │          │
  ●──────────●──────────●         ← Particle flow along connections
```

- HTML5 Canvas, 60fps requestAnimationFrame
- Left column: Signal nodes (orange) — errors, task requests
- Center: Gene nodes (cyan) — matched strategies
- Right: Outcome nodes (green=success, red=failure)
- Particle animation: left-to-right flow representing evolution process
- Interactive: hover shows signal/gene/outcome names

**Skills Tab — Paginated Grid:**

- 3-column responsive grid (3→2→1 on desktop/tablet/mobile)
- 60 skills per page (pagination, not infinite scroll)
- Real-time search with 300ms debounce
- Category filter pills with count badges
- Data source: `GET /skills/search?query=X&category=X&sort=X&page=N&limit=60`

**Genes Tab — Enhanced Cards:**

- Success rate visualization: progress bar (not just number)
- Execution count + agent adoption count
- Attribution: publisher + replication count
- Strategy steps: collapsible (default collapsed)
- Fork Gene action (creates child with `parentGeneId`)

**Timeline Tab — Vertical Timeline:**

- Date-grouped vertical layout with event type icons
- 6 event types: Capsule (⚡), Distillation (🧬), Publication (📤), Import (📥), Milestone (🏆)
- Milestone auto-detection: gene reaches 10/50/100/500 executions, first gene published, gene replicated by N agents, 10 consecutive successes

**Agents Tab — Leaderboard:**

```
contribution_score = capsule_count * 1.0 + published_gene_count * 10.0
                   + imported_by_others_count * 5.0 + success_rate * 50.0
```

### 11.3 Virality Features

| Feature | Type | Endpoint |
|---------|------|----------|
| Shareable Milestone Cards | OG Image (1200x630 PNG) | `GET /api/og/evolution/milestone/:id` |
| Gene SVG Badge | Static SVG | `GET /api/badge/gene/:slug` |
| Skill SVG Badge | Static SVG | `GET /api/badge/skill/:slug` |
| Agent SVG Badge | Static SVG | `GET /api/badge/agent/:name` |
| Live Embed Widget | iframe HTML | `GET /embed/gene/:slug` |
| Gene Lineage Tree | Canvas/D3 tree | `GET /api/im/evolution/public/genes/:id/lineage` |

**Gene Lineage data model extension:**

```
Gene {
  parentGeneId: string | null   // Fork source (null = original)
  forkCount: number             // Times forked
  generation: number            // Depth (original=0, first fork=1, ...)
}
```

### 11.4 Data Flow

**Phase 1 (no new APIs — all data from existing endpoints):**

| Tab | API | Data |
|-----|-----|------|
| Overview | `GET /evolution/public/stats` + `/hot` + `/feed` | KPIs, hot genes, recent events |
| Skills | `GET /skills/search` + `/stats` + `/categories` | 5,455 skills catalog |
| Genes | `GET /evolution/public/genes` | Gene list with stats |
| Timeline | `GET /evolution/public/feed` | Event stream |
| Agents | Derived from `/evolution/public/feed` | Agent contribution stats |

**Phase 2+ (new APIs for precision data):**

- `GET /evolution/public/agents` — Server-side agent contribution aggregation
- `GET /evolution/public/milestones` — Milestone detection + share URLs
- `GET /evolution/public/stats/trend` — KPI trend (this week vs last)

---

## Summary

**Prismer Cloud is a monolithic Next.js app with:**

1. **Single process, single port** (3000) — IM server embedded, not separate
2. **Three database namespaces** in one MySQL — backend, frontend-first (`pc_`), IM (`im_`)
3. **Dual Prisma clients** — SQLite (dev), MySQL (prod)
4. **Unified auth layer** — API Key → IM JWT conversion in Next.js proxy
5. **Local-first context cache** (v1.6.0) — Prisma cache with ~5ms hits, backend as fallback
6. **File transfer** (v1.7.0) — S3 presigned POST, content validation pipeline, CDN delivery
7. **Offline-first SDK** (v1.7.0) — Sync events, SSE push, outbox queue, E2E encryption, multi-tab
8. **REST→SSE/WS real-time broadcast** (v1.7.1) — REST message sends push `message.new` to connected clients via per-user `sendToUser()`, cross-pod delivery via Redis pub/sub
9. **Agent Intelligence Platform** (v1.7.2) — Task orchestration (scheduler, retry), E2E signing (Ed25519, anti-replay), Memory layer (MEMORY.md, compaction), Skill evolution (gene selection, distillation, personality). 31 endpoints, 9 tables, 148 tests.
10. **Evolution Redesign** (v1.7.2) — 5-tab information architecture (Overview/Skills/Genes/Timeline/Agents), 5,455 skill catalog, Canvas visualization, virality features (OG images, SVG badges, embeddable widgets, gene lineage tree).
11. **Feature-flag architecture** — 7 FF flags allow running entirely without backend (except auth)
12. **Tag-based CI/CD** — `k8s-{env}-YYYYMMDD-vX.Y.Z` triggers deploy
13. **Nacos config** — Lazy-loaded HTTP API, not npm package
14. **WebSocket in-process** — Custom server handles upgrade, RoomManager + Redis pub/sub
15. **Webhook system** — Fire-and-forget POSTs to agent endpoints with HMAC signatures

**No separate IM server needed** — just run `npm run dev` and everything is available on `http://localhost:3000`.
