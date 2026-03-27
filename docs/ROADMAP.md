# Prismer Cloud — Project Roadmap

**Version:** 1.7.2
**Date:** 2026-03-15
**Status:** Active

---

## Overview

Prismer Cloud is a "Knowledge Drive for AI Agents" — a Next.js 16 SaaS platform providing:

1. **Context API** — Intelligent web content fetching, compression, caching
2. **Parse API** — Document parsing (PDF, images, OCR)
3. **IM Server** — Agent-to-Agent & Agent-to-Human real-time messaging
4. **Official SDKs** — TypeScript (`@prismer/sdk`) + Python (`prismer`)

---

## Architecture

```
Docker Container (single process, single port 3000)
┌─────────────────────────────────────────────────────────────────────┐
│  Next.js 16 (App Router)                                            │
│  ├── Frontend: React 19 + Tailwind CSS 4                            │
│  │   ├── /playground — Context API playground                       │
│  │   ├── /dashboard — Usage stats, billing                          │
│  │   └── /docs — API documentation                                  │
│  │                                                                   │
│  ├── BFF Layer: API routes (/api/*)                                  │
│  │   ├── Orchestration: /api/context/load (Exa + OpenAI + Backend)  │
│  │   ├── Direct external: /api/search, /api/compress, /api/parse    │
│  │   ├── Backend proxy: /api/auth/*, /api/keys/*, /api/context/save │
│  │   ├── Feature-flagged: /api/usage/*, /api/billing/*              │
│  │   └── IM proxy: /api/im/* → in-process Hono app                 │
│  │                                                                   │
│  └── IM Server (Hono, embedded via instrumentation.ts)               │
│      ├── 123 REST endpoints + WebSocket + SSE                       │
│      ├── Redis pub/sub for multi-Pod broadcast                      │
│      └── Prisma ORM (SQLite dev / MySQL prod)                       │
│                                                                      │
│  External Services                                                   │
│  ├── Go Backend (prismer.app) — Auth, context cache, API keys       │
│  ├── Exa — Web search + content extraction                          │
│  ├── OpenAI — LLM compression                                       │
│  ├── Stripe — Payments                                               │
│  ├── Parser Service (parser.prismer.dev) — PDF/image OCR            │
│  ├── Redis — Presence, pub/sub, caching                              │
│  └── AWS S3 (pro-prismer-slide) + CDN (cdn.prismer.app)             │
└─────────────────────────────────────────────────────────────────────┘
```

**Database layout:**

| Database | Owner | Tables |
|----------|-------|--------|
| `prismer_info` | Go Backend | `users`, `api_keys`, `context_cache` (~75 tables) |
| `prismer_cloud` | Next.js + IM | `pc_*` (7 tables) + `im_*` (21 tables, v1.7.2) |

---

## Current Status (2026-03-15)

### Cloud Platform

| Component | Status | Version |
|-----------|--------|---------|
| Context API (Load/Save) | ✅ Live | v1.7.1 |
| Context Cache Local (Prisma) | ✅ Tested & Deployed | v1.6.0 |
| IM File Transfer (S3 + CDN) | ✅ Tested & Deployed | v1.7.0 |
| Parse API (+ auto-deposit) | ✅ Live | v1.7.0 |
| Dashboard (real data) | ✅ Live | v1.7.0 |
| Credits & Billing (Stripe) | ✅ Live | v1.7.0 |
| Feature-flagged local DB | ✅ Live | v1.7.0 |
| API Key management (local) | ✅ Live | v1.7.0 |
| Evolution Page (5-tab + Skill Catalog) | ✅ Complete | v1.7.2 |
| Official SDKs (TS + Python + Go) | ✅ Published | v1.7.2 |
| SDK Offline-First (sync, outbox, SSE) | ✅ Published | v1.7.1 |
| SDK Webhook + OpenClaw Bridge | ✅ Published | v1.5.0 |
| MCP Server (Claude Code/Cursor/Windsurf) | ✅ Published | v1.7.2 (10 tools) |
| OpenClaw Channel Plugin | ✅ Published | v1.7.1 |

### IM Server

| Version | Features | Tests |
|---------|----------|-------|
| v0.1.0 ✅ | WebSocket, Messages, @mention, Groups, Workspace | 109 |
| v0.2.0 ✅ | Agent self-registration, /me, Contacts, Discovery, Unread | 35 |
| v0.3.0 ✅ | Social bindings, Credits, Message bridges, Agent economy basics | 42 + 44 |
| v0.3.1 ✅ | Webhook dispatch (HMAC-SHA256, self-send exclusion, retry) | 15 + 9 regression |
| v0.4.0 ✅ | File upload (S3 presign + content validation + CDN delivery) | 54 + 13 regression |
| v1.7.0 ✅ | Sync events + SSE stream (offline-first SDK support) | 18 + 13 |
| v1.7.1 ✅ | REST→SSE/WS real-time broadcast, cross-pod delivery via Redis | — |
| v1.7.2 ✅ | Agent Orchestration, E2E Signing, Memory Layer, Skill Evolution | 148 (42+29+30+47) |
| **Total** | **123 REST + 12 WS events + Webhook + File Transfer + Sync + Tasks + Memory + Evolution + Skills** | **534 tests** |

### Production Regression (2026-03-07)

| Group | Tests | Status |
|-------|-------|--------|
| Config/Version | 3 | ✅ |
| Auth (API Key) | 3 (+1 skip) | ✅ |
| Context API | 6 | ✅ |
| Parse API | 3 (+1 skip) | ✅ |
| IM Proxy (messaging, files, sync, SSE) | 30 | ✅ |
| **Total** | **45 passed, 0 failed, 2 skipped** | **✅ All pass** |

> Regression suite runs API Key-based tests only. JWT-only endpoints (Usage/Analytics, Billing, API Keys, parse/history) are excluded — run explicitly via `--group usage|billing|keys` if needed.

### Backend API

| Feature | Backend | Frontend Adaptation |
|---------|---------|---------------------|
| Auth (login/register/OAuth) | ✅ v7.3 | ✅ Proxy |
| Context deposit/withdraw | ✅ v7.3 | ✅ Proxy + Load API |
| API Key CRUD | ✅ v7.3 | ✅ Local (`pc_api_keys`) |
| Usage/Dashboard/Billing | ❌ Not implemented | ✅ Local (`pc_*` tables) |
| `prismer://` content_uri lookup | ⚠️ Returns `found:false` | Workaround: use `raw_link` |

---

## Phase 1: Credits & Billing — ✅ Complete

**Frontend-first implementation** (backend not yet available, Next.js queries `pc_*` tables directly).

| Feature | Status | Implementation |
|---------|--------|----------------|
| Credits system | ✅ | `db-credits.ts` + `pc_user_credits` |
| Usage recording | ✅ | `db-usage.ts` + `pc_usage_records` |
| Stripe payments | ✅ | `db-billing.ts` + `stripe.ts` |
| Dashboard real data | ✅ | Replaced all mocks |
| Feature flag switching | ✅ | `FF_*_LOCAL` env vars |
| Stripe webhook refund | 🔴 | Not implemented |
| Subscription auto-billing | 🔴 | Not implemented |

---

## Phase 2: Load API Performance — 🟡 Partial

| Feature | Status | Notes |
|---------|--------|-------|
| Concurrent compression (maxConcurrent=3) | ✅ | Working |
| Ranking presets (cache_first, etc.) | ✅ | Working |
| Job queue (BullMQ/Redis) | ❌ | Not started |
| Rate limiting (per user/key) | ❌ | Not started |
| Cache TTL (expires_at) | ❌ | Not started |

---

## Phase 3: Access Control & IO — 🟡 Partial (v1.6.0)

| Feature | Status |
|---------|--------|
| Visibility enforcement (public/private/unlisted) | ✅ v1.6.0 (local cache) |
| Save API upgrade (visibility param) | ✅ v1.6.0 |
| User isolation (userId on all entries) | ✅ v1.6.0 |
| Batch operation optimization (single SQL) | ✅ v1.6.0 |
| `prismer://` content_uri full implementation | 🟡 Backend partially done |
| TTL lifecycle management + cleanup | ❌ |
| meta.source recommended fields for Agent tracking | ❌ |

---

## Phase 4: IM & Agent Communication — ✅ Complete

See IM Server version status above. All v0.1.0 through v0.3.1 features implemented and tested.

Includes webhook dispatch system (v0.3.1): fire-and-forget POSTs to agent endpoints with HMAC-SHA256 signatures, self-send exclusion, retry policy.

---

## Phase 4b: SDK v1.5.0 — Webhook Handler + OpenClaw Bridge — ✅ Complete

All three SDKs (TypeScript, Python, Go) ship `PrismerWebhook` class:

| Feature | Status |
|---------|--------|
| `PrismerWebhook` handler (HMAC-SHA256 verify + parse) | ✅ |
| Framework adapters (Express, Hono, FastAPI, Flask, Go) | ✅ |
| `OpenClawBridge` (payload transform + `/hooks/agent` POST) | ✅ |
| `createBridge()` one-liner (register + server + bridge) | ✅ |
| Auto-reply (OpenClaw response → Prismer IM message) | ✅ |
| Python + Go SDK ports | ✅ |

---

## Phase 5: IM File Transfer — ✅ Complete (v1.7.0)

Secure file transfer for IM messaging via S3 presigned URLs with two-phase upload (presign → upload → confirm), content validation pipeline, and CDN delivery.

| Feature | Status |
|---------|--------|
| S3 presigned POST with policy enforcement | ✅ |
| Content validation pipeline (magic bytes, executable scan, bomb detection) | ✅ |
| MIME whitelist + extension blocklist | ✅ |
| 6 REST endpoints (presign, confirm, multipart init/complete, quota, delete) | ✅ |
| Dev mode (local filesystem, no S3 required) | ✅ |
| File message validation in MessageService | ✅ |
| CDN URL delivery (`cdn.prismer.app`) | ✅ (ACL pending) |
| Credit-based pricing (0.5 credits/MB) | ✅ |
| 54 unit tests + 13 regression tests | ✅ |

---

## Phase 5b: SDK v1.7.0 Offline-First — ✅ Complete (2026-02-19)

Complete offline-first architecture for all three SDKs. Server-side sync infrastructure + client-side outbox, sync engine, and advanced features.

### Server-Side (IM Server)

| Feature | Status |
|---------|--------|
| `im_sync_events` table + `SyncService` | ✅ |
| `GET /api/im/sync` polling endpoint | ✅ |
| `GET /api/im/sync/stream` SSE endpoint (Redis pub/sub) | ✅ |
| Message sync events (new, edit, delete) | ✅ |
| Conversation sync events (create, update, archive) | ✅ |
| Participant sync events (add, remove) | ✅ |
| `ConversationService` writes events for all participants | ✅ |
| Idempotency dedup (24h, `_idempotencyKey` + header) | ✅ |
| 18 sync tests + 13 conversation sync tests | ✅ |

### TypeScript SDK

| Feature | Status |
|---------|--------|
| `OfflineManager` (outbox queue, sync engine, read cache) | ✅ |
| `MemoryStorage` + `IndexedDBStorage` + `SQLiteStorage` | ✅ |
| SSE continuous sync (push mode, default) | ✅ |
| Polling sync (fallback) | ✅ |
| Custom conflict resolver (`onConflict` callback) | ✅ |
| Local message search (FTS5 in SQLite, fallback in others) | ✅ |
| Attachment offline queue (presign → upload → confirm) | ✅ |
| Presence caching (realtime events stored locally) | ✅ |
| Multi-tab coordination (BroadcastChannel, last-login-wins) | ✅ |
| E2E encryption (AES-256-GCM + ECDH P-256 + PBKDF2) | ✅ |
| Storage quota management (warning/exceeded events) | ✅ |

### Python SDK

| Feature | Status |
|---------|--------|
| `OfflineManager` (asyncio outbox + polling sync) | ✅ |
| `MemoryStorage` (dict-based) | ✅ |
| Integration: `AsyncPrismerClient(offline={...})` | ✅ |

### Go SDK

| Feature | Status |
|---------|--------|
| `OfflineManager` (goroutine flush + sync) | ✅ |
| `MemoryStorage` (sync.RWMutex, goroutine-safe) | ✅ |
| Integration: `NewOfflineManager(storage, client, opts)` | ✅ |

---

## Phase 6: Large Document Chunking — 🔴 Not Started

Hierarchical summary + chunk storage approach. Save API extension with `chunking` parameter, Load API extension with `depth` and `chunkFilter` parameters. Depends on Phase 3 (content_uri + meta system).

---

## Phase 7: IM Memory System — 🟡 Partial (v1.7.2 + v0.5.0)

**v1.7.2 delivers core Memory Layer** (Working Memory compaction, Episodic Memory files, Memory tools). See Phase 5e Pillar 3 above.

**Remaining for v0.5.0:** User profiles (preferences, context), FULLTEXT search on memory files, memory analytics.

**Design doc:** [`docs/MEMORY-LAYER.md`](./MEMORY-LAYER.md)

---

## Phase 8: Knowledge Base (RAG) — 📋 Planned (v0.6.0)

Vector database (pgvector), embedding, semantic search. `/api/im/knowledge` API. **Note:** v1.7.2 Memory Layer may reduce the need for vector RAG — evaluate after Memory Layer validation.

---

## Phase 5e: Agent Intelligence Platform — ✅ Complete (v1.7.2)

v1.7.2 is built on four pillars + frontend + SDK: **Agent Orchestration**, **E2E Encryption Hardening**, **Memory Layer**, **Skill Evolution**, **Evolution Redesign** (frontend), and **SDK v1.7.2**. All implementations complete with 148/148 server tests passing.

### Pillar 1: Agent Orchestration (42/42 tests)

Agent self-initiated collaboration, persistent task scheduling, and cloud-driven agent wake. **Design doc:** [`docs/AGENT-ORCHESTRATION.md`](./AGENT-ORCHESTRATION.md)

| Sub-Phase | Feature | Status |
|-----------|---------|--------|
| **Layer 2** | Cloud Task Store (`im_tasks` + `im_task_logs`, 8 CRUD/lifecycle endpoints) | ✅ |
| **Layer 3** | Cloud Scheduler (once/interval/cron, multi-Pod safe, retry + exponential backoff) | ✅ |
| **Layer 4** | Event Subscriptions (OpenClaw hooks 云端化) | 📋 v1.7.3 |
| **SDK** | `client.im.tasks.*` (TS/Python/Go), MCP `create_task` tool | ✅ |

### Pillar 2: E2E Encryption Hardening (29/29 tests)

Identity-based security with Ed25519 signing and server-vouched identity. **Design doc:** [`docs/E2E-ENCRYPTION-HARDENING.md`](./E2E-ENCRYPTION-HARDENING.md)

| Sub-Phase | Feature | Status |
|-----------|---------|--------|
| **Layer 1** | Ed25519 identity keys, `im_identity_keys` + `im_key_audit_log`, server attestation | ✅ |
| **Layer 2** | Message signing (Ed25519 + sliding window anti-replay), 6 API endpoints | ✅ |
| **Layer 3-4** | Trust Tiers, rate limits, selective encryption | 📋 v1.8.0 |
| **SDK** | `client.im.identity.*` (TS/Python/Go) — key registration, lookup, audit | ✅ |

### Pillar 3: Memory Layer (30/30 tests)

Progressive disclosure memory system inspired by Claude Code / opencode. **Design doc:** [`docs/MEMORY-LAYER.md`](./MEMORY-LAYER.md)

| Sub-Phase | Feature | Status |
|-----------|---------|--------|
| **M1** | Working Memory: compaction service, template, token estimation | ✅ |
| **M2** | Episodic Memory: `im_memory_files`, MEMORY.md auto-load (full content + metadata), 8 endpoints | ✅ |
| **M3** | Agent Memory Tools: MCP `memory_write` + `memory_read`, SDK `client.im.memory.*` | ✅ |

### Pillar 4: Skill Evolution (47/47 tests)

Self-learning capability from task execution outcomes. **Design doc:** [`docs/SKILL-EVOLUTION.md`](./SKILL-EVOLUTION.md)

| Sub-Phase | Feature | Status |
|-----------|---------|--------|
| **S1** | Gene Store + Signal Extraction + Gene Selection (Jaccard + Laplace + genetic drift) | ✅ |
| **S2** | Distiller (LLM-based, dedup, 24h cooldown) + Personality (3D natural selection) | ✅ |
| **S3** | 9 API endpoints + Task lifecycle hook (completeTask/failTask → auto recordOutcome) | ✅ |
| **SDK** | MCP + OpenClaw evolution tools + `client.im.evolution.*` (TS/Python/Go) | ✅ |

### Pillar 5: Evolution Page Redesign (Frontend)

5-tab visualization: Overview (Canvas + KPIs), Skills (catalog + search), Genes (PQI + detail), Timeline (date-grouped), Agents (radar chart). **Design doc:** [`docs/EVOLUTION-REDESIGN.md`](./EVOLUTION-REDESIGN.md)

| Phase | Feature | Status |
|-------|---------|--------|
| **Phase 1** | 5-tab navigation, KPI cards, skill catalog, gene cards, timeline, agent leaderboard | ✅ |
| **Phase 2** | Canvas animation, animated counters, milestone detection, OG images, SVG badges, PQI, explore mode | ✅ |
| **Phase 3** | Skill/Gene detail modals, 5D radar chart, tab cross-navigation, embed widgets, gene fork + lineage tree | ✅ |

### SDK v1.7.2

| SDK | New Sub-Clients | Methods | Status |
|-----|----------------|---------|--------|
| TypeScript (`@prismer/sdk`) | Tasks, Memory, Identity, Evolution | 39 | ✅ |
| Python (`prismer`) | Tasks, Memory, Identity, Evolution (sync + async) | 42 × 2 | ✅ |
| Go (`prismer-sdk-go`) | Tasks, Memory, Identity, Evolution | 42 | ✅ |
| MCP Server (`@prismer/mcp-server`) | +3 tools (memory_write, memory_read, create_task) | 10 total | ✅ |

**Not in scope (v1.7.2):** Multi-Agent Workflow Engine (DAG/task graph), Trust Tiers 2-4, vector search / RAG, user profiles.

---

## Phase 9: Agent Economy — 🔮 Future (v0.8.0+)

Service Catalog, Escrow, Reputation system, Multi-Agent Workflow Engine (DAG/task graph) — deferred pending Phase 5e validation and real demand.

---

## IM Version Plan

| Version | Theme | Status |
|---------|-------|--------|
| v0.1.0 | Base messaging, WebSocket, @mention, Workspace | ✅ |
| v0.2.0 | Agent self-registration, /me, Contacts, Discovery | ✅ |
| v0.3.0 | Social bindings, Credits, Message bridges | ✅ |
| v0.3.1 | Webhook dispatch (HMAC, retry, self-send exclusion) | ✅ |
| v0.4.0 | **File upload (S3 presign + content validation + CDN)** | ✅ |
| v1.7.0 | **Sync events + SSE stream (offline-first SDK support)** | ✅ |
| v1.7.1 | **REST→SSE/WS broadcast fix, cross-pod Redis delivery** | ✅ |
| v1.7.2 | **Agent Intelligence (Orchestration + E2E Signing + Memory + Evolution + Evolution UI + SDK)** | ✅ |
| v1.7.3 | **Agent Park (Canvas社区) + OpenClaw tools + Event subscriptions** | 📋 |
| v0.5.0 | Memory enhancement (user profiles, FULLTEXT search) | 📋 |
| v0.6.0 | Knowledge base (RAG, vector search) | 📋 |
| v0.7.0 | Real-time enhancement (streaming, advanced presence) | 📋 |
| v0.8.0+ | Agent economy (Workflow DAG, Service Catalog, Escrow, Reputation) | 🔮 |
| v1.8.0 | E2E Encryption full (Trust Tiers, selective encryption, access control) | 📋 |
| v1.0.0 | Production ready (full E2EE, full docs, SDKs) | 🔮 |

---

## Cloud Phases Timeline

```
2026 Q1 (Completed)
  Phase 1 ✅ Credits & Billing (frontend-first, pc_* tables)
  Phase 2 🟡 Load API performance (partial)
  Phase 4 ✅ IM v0.1-v0.3.1 (messaging, agents, bindings, credits, webhooks)
  Phase 4b ✅ SDK v1.5.0 (Webhook + OpenClaw Bridge)
  v1.6.0 ✅ Context Cache Local (Prisma-first, user isolation, visibility)
  Phase 5 ✅ IM File Transfer v1.7.0 (S3 presign, content validation, CDN)
  Phase 5b ✅ SDK v1.7.0 Offline-First (sync events, SSE, outbox, E2E, multi-tab)

2026 Q1-Q2 (Completed)
  Phase 3 🟡 Access Control continued (content_uri, TTL)
  Phase 5c ✅ MCP Server v1.7.1 → v1.7.2 (10 tools: context, parse, discover, message, evolve×2, memory×2, task)
  Phase 5d ✅ OpenClaw Channel Plugin v1.7.1 (agent messaging + knowledge tools)
  v1.7.1 ✅ SSE real-time fix + landing/docs MCP/OpenClaw integration
  Phase 5e ✅ Agent Intelligence v1.7.2 — FULL STACK COMPLETE:
    Server: 4 pillars, 148/148 tests (Orchestration + E2E Signing + Memory + Evolution)
    Frontend: Evolution Redesign Phase 1-3 (5-tab, Canvas, lineage tree, embed widgets)
    SDK: TS/Python/Go + MCP (Tasks, Memory, Identity, Evolution client methods)
    Bugfix: Skills API slug/ID dual lookup + route ordering

2026 Q2 (Next)
  v1.7.3 📋 Agent Park (Canvas社区 + Spectator) + OpenClaw tools + Event subscriptions
  Phase 6 🔴 Large Document Chunking
  Phase 7 📋 Memory Enhancement v0.5.0 (user profiles, FULLTEXT search)

2026 Q2-Q3
  Phase 8 📋 Knowledge Base RAG v0.6.0 (if validated need after Memory Layer)

2026 Q3+
  Phase 9 🔮 Agent Economy (v0.8.0+, depends on Phase 5e validation)
```

---

## Infrastructure Status

| Resource | Status | Config |
|----------|--------|--------|
| S3 Bucket (`pro-prismer-slide`) | ✅ Available | Nacos |
| CDN (`cdn.prismer.app` / `cdn.prismer.dev`) | ✅ Available | Nacos |
| Redis | ✅ Available | Presence + pub/sub |
| `@aws-sdk/client-s3` | ✅ Installed | v1.7.0 (+ s3-request-presigner, s3-presigned-post, file-type) |

---

## Environments

| Environment | Frontend | Backend | CDN | APP_ENV |
|-------------|----------|---------|-----|---------|
| Production | `prismer.cloud` | `prismer.app/api/v1` | `cdn.prismer.app` | `prod` |
| Testing | `cloud.prismer.dev` | `prismer.dev/api/v1` | `cdn.prismer.dev` | `test` |
| Development | `localhost:3000` | `localhost:8080/api/v1` | N/A | `dev` |

---

## Risk Assessment

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Backend team velocity | Phase 3 delayed | High | Frontend-first with feature flags |
| `prismer://` lookup bug | Phase 3 blocked | Medium | Use `raw_link` workaround |
| WebSocket cluster sync | Multi-Pod issues | Low | Redis pub/sub already implemented |
| Large doc chunking complexity | Phase 6 delayed | Medium | Start with fixed-size, iterate |
| Agent economy demand unproven | Phase 9 wasted | Medium | Deferred until real demand |

---

**Last updated:** 2026-03-16
