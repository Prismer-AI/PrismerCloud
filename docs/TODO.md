# Prismer Cloud — TODO

**Version:** 1.7.2
**Date:** 2026-03-16
**Status:** Active

---

## Current Sprint: v1.7.2 — Agent Intelligence Platform ✅ Complete

v1.7.1 deployed to production (`k8s-prod-20260307-v2.1.26`). v1.7.2 server-side code (148/148 tests) was deployed as v2.1.27 but rolled back to v2.1.26 baseline (tagged v2.1.28) pending frontend completion.

**v1.7.2 五大支柱 — 全部完成：**

**Server-Side (✅ 148/148 tests):**

1. **Agent Orchestration** — 42/42 tests → [`docs/AGENT-ORCHESTRATION.md`](./AGENT-ORCHESTRATION.md)
2. **E2E Encryption Hardening** — 29/29 tests → [`docs/E2E-ENCRYPTION-HARDENING.md`](./E2E-ENCRYPTION-HARDENING.md)
3. **Memory Layer** — 30/30 tests → [`docs/MEMORY-LAYER.md`](./MEMORY-LAYER.md)
4. **Skill Evolution** — 47/47 tests → [`docs/SKILL-EVOLUTION.md`](./SKILL-EVOLUTION.md)

**Frontend (✅ Phase 1-3 全部完成):** 5. **Evolution Redesign** — 5-tab + 进化树 + Embed Widget → [`docs/EVOLUTION-REDESIGN.md`](./EVOLUTION-REDESIGN.md)

**SDK (✅ v1.7.2 — TS/Python/Go/MCP):** 6. **SDK Client Methods** — Tasks/Memory/Identity/Evolution (39+42×2+42+3 tools)

---

### 支柱一：Agent Orchestration ✅ Server Done (42/42 tests)

#### Phase 0: Agent Tools 补全

- [ ] `prismer_discover` tool — OpenClaw channel plugin (SDK 侧)
- [ ] `prismer_send` tool — OpenClaw channel plugin (SDK 侧)
- [ ] `prismer_schedule` tool — 创建 Cloud 持久化定时任务
- [ ] MCP server: verify `discover_agents` + `send_message` work end-to-end
- [ ] SDK unit tests for new tools

#### Phase 1: Cloud Task Store ✅

- [x] `im_tasks` table (Prisma model + MySQL migration 011)
- [x] `im_task_logs` table (audit trail)
- [x] Task CRUD API: `POST/GET /api/im/tasks`, `GET/PATCH /api/im/tasks/:id`
- [x] Task lifecycle: `POST /api/im/tasks/:id/claim`, `/complete`, `/fail`
- [x] Task WS/SSE push + sync event 反向驱动 Agent
- [x] Task timeout handling (30s sweep)
- [x] Optimistic concurrency for multi-Pod safety

#### Phase 2: Cloud Scheduler ✅

- [x] `SchedulerService` in IM Server process (10s interval scan)
- [x] One-shot delayed tasks (`schedule_type: "once"`)
- [x] Cron tasks (`schedule_type: "cron"`)
- [x] Interval tasks (`schedule_type: "interval"`)
- [x] `next_run_at` computation + `run_count` / `max_runs`
- [x] Retry policy: `max_retries` + `retry_delay_ms` + 指数退避

#### Phase 3: Event Subscriptions（v1.7.3 推迟）

- [ ] `im_subscriptions` table
- [ ] Subscription API: `POST/GET/DELETE /api/im/subscriptions`
- [ ] Event types: `task.created`, `task.completed`, `agent.online`, `agent.offline`
- [ ] Subscription matching + delivery

---

### 支柱二：E2E Encryption Hardening ✅ Server Done (29/29 tests)

#### Phase E1: Identity ✅

- [x] Ed25519 密钥对注册 (`PUT /api/im/keys/identity`)
- [x] `im_identity_keys` 表 + Prisma model + MySQL migration 010
- [x] Server attestation (Ed25519 签名证明)
- [x] `im_key_audit_log` (hash-chained, append-only)
- [x] Key rotation + revocation + re-registration

#### Phase E2: Message Signing ✅

- [x] 消息发送时验证 Ed25519 签名 (messages.ts, direct.ts, groups.ts)
- [x] Sliding window 防重放 (64-bit, IPsec RFC 4303)
- [x] Per-conversation signing policy (optional/recommended/required)
- [ ] SDK 自动签名 (SDK 侧待实现)

---

### 支柱三：Memory Layer ✅ Server Done (30/30 tests)

#### Phase M1: Working Memory — Compaction ✅

- [x] `im_compaction_summaries` 表 + MySQL migration 008
- [x] Compaction API: `POST /api/im/memory/compact`
- [x] Compaction template (Goal/Context/Progress/Key Information)

#### Phase M2: Episodic Memory — Memory Files ✅

- [x] `im_memory_files` 表 + MySQL migration 008
- [x] Memory Files CRUD API (5 endpoints)
- [x] MEMORY.md 自动加载 (完整内容 + totalLines/totalBytes 元数据)
- [x] 乐观锁 (version) + 409 Conflict

#### Phase M3: Agent Memory Tools ✅

- [ ] OpenClaw plugin: `prismer_memory_write` tool (deferred)
- [ ] OpenClaw plugin: `prismer_memory_read` tool (deferred)
- [x] MCP server: `memory_write` + `memory_read` tools
- [x] SDK client: `client.im.memory.*` (TS/Python/Go)

---

### 支柱四：Skill Evolution ✅ Server Done (47/47 tests)

- [x] Gene Store + Selection (Jaccard + Laplace + 遗传漂变)
- [x] Evolution edges + capsules + memory graph
- [x] 3维 Personality adaptation (rigor/creativity/risk_tolerance)
- [x] LLM Distillation (triggerDistillation + OpenAI + JSON验证 + 去重)
- [x] Task lifecycle hook (completeTask/failTask → auto recordOutcome)
- [x] MCP tools: evolve_analyze, evolve_record
- [x] OpenClaw tools: prismer_evolve_analyze, prismer_evolve_record, prismer_gene_create

---

### 支柱五：Evolution Redesign ✅ Frontend Complete

> 详细设计: [`docs/EVOLUTION-REDESIGN.md`](./EVOLUTION-REDESIGN.md)

#### Phase 1: 信息架构重构 ✅

- [x] 5-tab 导航框架 (Overview / Skills / Genes / Timeline / Agents)
- [x] Overview: KPI Cards + "How Evolution Works" 四步流程 + Hot Genes
- [x] Skills: 5,455 skills 搜索/分类/分页 (60/页) + Skill Card Grid
- [x] Genes: 成功率进度条 + 执行量 + Attribution + Strategy 折叠
- [x] Timeline: 垂直时间线 + 事件类型图标
- [x] Agents: 贡献排行榜 (contribution_score 算法)

#### Phase 2: 可视化 + 传播基础 ✅

- [x] Overview Canvas 动画 (Signal→Gene→Outcome 粒子流)
- [x] KPI 动画计数器 + 趋势对比 (本周 vs 上周)
- [x] Timeline 日期分组 + Milestone 自动检测
- [x] Shareable Milestone Cards (OG Image 1200x630px)
- [x] Static SVG Badges (`/api/badge/gene/:slug` etc.)
- [x] Gene Lineage 数据模型 (parentGeneId, forkCount, generation)

#### Phase 3: 交互 + 外嵌 ✅

- [x] Skill Detail Modal + Related Skills
- [x] Gene Detail Panel + Execution History + Lineage Stats
- [x] Agent Detail + 5维雷达图
- [x] Tab 间跳转 (Skill→Gene, Gene→Agent)
- [x] Live Embed Widget (iframe pages: `/embed/gene/[slug]`, `/embed/skill/[slug]`)
- [x] Gene Fork 功能 + 进化树可视化 (SVG LineageTree)

---

### SDK v1.7.2 Release ✅

**已完成 (SDK tools):**

- [x] MCP tools: evolve_analyze, evolve_record (sdk/mcp/src/tools/)
- [x] OpenClaw tools: prismer_evolve_analyze, prismer_evolve_record, prismer_gene_create

**已完成 (SDK client methods):**

- [x] TypeScript SDK: Task API client methods (`client.im.tasks.*`)
- [x] TypeScript SDK: Memory API client (`client.im.memory.*`)
- [x] TypeScript SDK: Ed25519 key management (`client.im.identity.*`)
- [x] Python SDK: Task/Memory/Identity/Evolution client methods (sync + async)
- [x] Go SDK: Task/Memory/Identity/Evolution client methods (42 methods)
- [ ] OpenClaw plugin: `prismer_memory_write`, `prismer_memory_read` tools
- [x] MCP server: `memory_write`, `memory_read`, `create_task` tools (10 tools total)

**Release:**

- [ ] Update docs/API.md with all new endpoints (Task/Identity/Memory/Evolution/Skills)
- [ ] All README version bumps to v1.7.2
- [ ] Publish: npm, PyPI, Go tag

### Evolution Data Isolation + Security Enhancement (2026-03-23)

> 合并安全改进计划 (docs/im/SECURITY-IMPROVEMENT-PLAN.md)

#### 已完成

- [x] Prisma schema — 5 evolution 表加 scope + encrypted + ACL 新表 + ephemeralKeys
- [x] evolution.service.ts 拆分为 11 个子模块 (4945→594 行 facade)
- [x] updateGeneStats owner 检查（非 owner 不更新全局计数）
- [x] scope 过滤 — 所有 public 方法加 scope='global'
- [x] scope 透传 — selector/recorder/lifecycle/report/signals/metrics 全部加 scope 参数
- [x] P1.1 Rate Limiting 接入路由（evolution/files/tasks）
- [x] P1.2 Trust Tier 管理 API（admin.ts）
- [x] P2.1 加密模式管理 API（security.ts）
- [x] P2.2 ECDH 密钥交换 API（security.ts）
- [x] P2.3 密文格式验证 + Context Ref 头检查（message.service.ts）
- [x] P3.1 Scope 基础设施（utils/scope.ts — withScope + MULTI_TENANT）
- [x] MySQL 迁移脚本 019_evolution_scope_security.sql
- [x] evolution API endpoints 透传 scope query param
- [x] GET /api/evolution/scopes 新端点
- [x] SDK 4 语言 + MCP 加 scope 参数

#### 待验证

- [ ] 60+ scope/security 测试
- [ ] 现有 47 evolution tests 回归
- [ ] 全量 build 验证（Next.js + 4 SDK + MCP）

### Carry-over

- [ ] CDN ACL configuration for `im/files/*` S3 prefix (CloudFront → S3 path currently returns 403)

---

## Next Sprint: v1.7.3 — Agent Park + OpenClaw + Event Subscriptions

### Agent Park (`/park`)

- [ ] Canvas Agent 社区可视化 (8 Buildings = 平台端点)
- [ ] Agent 定位 (由最近活动类型派生)
- [ ] Spectator Mode (只读, 无需登录)
- [ ] Ghost Mode (离线 Agent 半透明)
- [ ] System Agents (prismer-gc, prismer-herald, prismer-gardener, prismer-sentinel)
- [ ] 匿名 SSE (`/api/im/park/stream`)
- [ ] Agent 移动动画 + Orbital Ring + 对话线
- [ ] "Enter Park" 认证 + 点击 Building 交互

### OpenClaw Channel Plugin v1.7.3

- [ ] `prismer_discover` tool — Agent 发现
- [ ] `prismer_send` tool — 消息发送
- [ ] `prismer_schedule` tool — Cloud 定时任务创建
- [ ] `prismer_memory_write` tool — 记忆写入
- [ ] `prismer_memory_read` tool — 记忆读取

### IM Server

- [ ] Event Subscriptions (`im_subscriptions` 表 + API)
- [ ] Evolution Phase 3.5: Gene 衰减机制 + Credit 正向激励

---

## Backlog: Platform

### Load API Performance

- [ ] Job queue (BullMQ/Redis) for background processing
- [ ] Rate limiting (per user/key)
- [ ] Cache TTL (`expires_at`) lifecycle management + cleanup cron

### Access Control & IO (builds on v1.6.0)

- [ ] `prismer://` content_uri generation in local deposit
- [ ] Save API: TTL parameter, user content (no URL required)
- [ ] `meta.source` recommended fields for Agent tracking

### Large Document Chunking

- [ ] Hierarchical summary + chunk storage design
- [ ] Save API `chunking` parameter
- [ ] Load API `depth` and `chunkFilter` parameters

---

## Backlog: SDK

### SDK v1.5.0 — Webhook Handler + OpenClaw Bridge ✅

All three SDKs ship `PrismerWebhook` class with HMAC-SHA256 verification, framework adapters, auto-reply, and OpenClaw bridge.

### SDK v1.7.0 — Offline-First ✅

Complete offline-first architecture across all three SDKs (TypeScript, Python, Go). Server-side sync events, SSE stream, outbox queue, conflict resolution, E2E encryption, multi-tab coordination, storage quota management.

### SDK v1.7.1 — SSE Real-Time Fix ✅ (2026-03-07)

Server-side fix: REST endpoints broadcast `message.new` to SSE/WS clients via per-user Redis pub/sub. All SDK packages published at v1.7.1.

### SDK v1.7.2 — Agent Intelligence Platform ✅ (2026-03-15)

Four new sub-clients (Tasks, Memory, Identity, Evolution) across all three SDKs + MCP server. See Current Sprint above.

### SDK File Transfer Methods (Deferred)

- [ ] `client.im.files.send()` — auto mode (simple vs multipart)
- [ ] Multipart chunking + resume + progress callback
- [ ] Python equivalent

---

## Backlog: IM Server

### v0.5.0 — Memory System (部分提前到 v1.7.2)

- [→] Working Memory / Compaction — **moved to v1.7.2 Phase M1**
- [→] Episodic Memory / MEMORY.md — **moved to v1.7.2 Phase M2**
- [ ] User profiles (preferences, context) — 留在 v0.5.0
- [ ] Memory search (FULLTEXT index on im_memory_files) — 留在 v0.5.0

### Evolution Map — Viewport + LOD (Step B, 待实施)

- [ ] 服务端 `/map` tile 分区：viewport 参数 + quad-tree 分区
- [ ] 服务端预计算 cluster membership（Louvain → DB 物化）
- [ ] 前端 viewport 感知 fetch：pan/zoom 触发增量加载
- [ ] 前端 tile 缓存：`Map<tileKey, EvolutionMapData>` + 30s TTL
- [ ] LOD 三级缩放：L0=cluster 摘要, L1=cluster 内 gene, L2=gene 详情
- [ ] 跳转 = 查 gene 所属 cluster → 加载该 cluster tile → 聚焦

**依赖:** Step A 锚点预加载 ✅ (已实施 2026-03-24)
**触发条件:** gene 数量 > 500 时开始影响渲染性能
**影响面:** ~10 文件 (服务端 3 + 前端编排 2 + canvas 交互 3 + types 1 + layout 1)

### v0.6.0 — Knowledge Base (RAG)

- [ ] Vector database integration (pgvector) — 如果 Markdown 记忆层验证后确有需求
- [ ] Embedding pipeline
- [ ] Semantic search endpoints

### v0.7.0 — Real-Time Enhancement

- [ ] Streaming message support
- [ ] Advanced presence (custom status, last seen)

### v1.7.2 — Agent Intelligence Platform ✅ (2026-03-15)

See Current Sprint above. Six pillars complete: Server P1-P4 (148/148 tests) + Frontend P5 (Evolution Redesign Phase 1-3) + SDK P6 (TS/Python/Go/MCP).

### v0.8.0+ — Agent Economy (Deferred)

- [ ] Service Catalog (pricing, SLA)
- [ ] Escrow system (budget lock → settle)
- [ ] Reputation system (ratings, levels)
- [ ] Multi-Agent Workflow Engine (DAG, task graph — requires state machine design)

---

## Backlog: Operations

### Database Migration

- [ ] Create `prismer_cloud` DB on production RDS
- [ ] Execute `pc_*` table creation scripts (7 tables)
- [ ] Execute `im_*` table creation scripts (9+ tables)
- [ ] Migrate `pc_*` data from `prismer_info`
- [ ] Update Nacos config

### Infrastructure

- [x] Install `@aws-sdk/client-s3` (v1.7.0)
- [ ] CDN ACL for `im/files/*` S3 prefix (currently returns 403)
- [ ] Stripe webhook refund handling
- [ ] Subscription auto-billing

---

## Recently Completed

### v1.7.2 — Agent Intelligence Platform ✅ (2026-03-15)

Full-stack v1.7.2 release: server + frontend + SDK.

**Server (148/148 tests):**

- Agent Orchestration: Cloud Task Store + Scheduler (42 tests)
- E2E Encryption Hardening: Ed25519 Identity + Message Signing (29 tests)
- Memory Layer: Working Memory Compaction + Episodic Memory Files (30 tests)
- Skill Evolution: Gene Selection + Distillation + 3D Personality (47 tests)

**Frontend — Evolution Redesign (Phase 1-3):**

- 5-tab navigation (Overview / Skills / Genes / Timeline / Agents)
- Overview: Canvas animation (Signal→Gene→Outcome particle flow) + animated KPI counters
- Skills: ClawHub catalog (~756 skills), search/filter/pagination, Explore mode, Trust badges
- Genes: PQI quality index, detail modal + execution history, lineage tree visualization (SVG)
- Timeline: date-grouped, 5 event types, auto milestone detection, shareable OG images
- Agents: contribution leaderboard, 5D radar chart, category breakdown
- Embed widgets: `/embed/gene/[slug]`, `/embed/skill/[slug]` (iframe friendly)
- SVG Badges: `/api/badge/gene/[slug]`, `/api/badge/skill/[slug]`, `/api/badge/agent/[name]`
- Gene Fork + Import (authenticated POST)
- Tab cross-navigation (Skill→Gene→Agent)

**SDK v1.7.2 (TS + Python + Go + MCP):**

- TypeScript: 4 new sub-clients (Tasks 8m, Memory 8m, Identity 6m, Evolution 17m = 39 methods)
- Python: sync + async variants (42 methods × 2)
- Go: 4 new sub-clients (42 methods)
- MCP Server: +3 tools (memory_write, memory_read, create_task → 10 tools total)

**Bugfix:**

- Skills API: `GET /:slugOrId` now supports both slug and UUID ID lookup
- Skills API: `GET /:id/related` route moved before catch-all to fix routing
- `@noble/curves` / `@noble/hashes` packages installed (Ed25519 crypto dependency)

### v1.7.1 — SSE Real-Time Fix + SDK Ecosystem ✅ (2026-03-07)

Server-side fix for `message.new` event delivery via SSE/WebSocket:

- REST message endpoints (`direct.ts`, `messages.ts`, `groups.ts`) now broadcast `message.new` to connected clients
- Cross-pod delivery via per-user `sendToUser()` through Redis pub/sub
- Unified Redis config (`REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`/`REDIS_DB`)
- Standalone server SSE support for local dev
- Landing page: "Works With Your Stack" section (MCP, OpenClaw, SDKs)
- Docs page: expanded Developer Tools with MCP/OpenClaw integration cards
- All SDK packages published at v1.7.1 (npm, PyPI, Go tag)
- Production: `k8s-prod-20260307-v2.1.26`, 45/45 regression pass

### v1.7.0 — SDK Offline-First ✅ (2026-02-19)

Complete offline-first SDK with 12 features implemented:

**Server-side:**

- Conversation sync events (`conversation.create/update/archive`, `participant.add/remove`)
- SSE sync stream endpoint (`GET /api/im/sync/stream` with Redis pub/sub)
- Sync events for all participants (including removed users)
- 18 sync tests + 13 conversation sync tests (31 total, all passing)

**TypeScript SDK (12 features):**

- SQLiteStorage (`better-sqlite3`, FTS5 full-text search)
- Custom conflict resolver (`onConflict` callback)
- Local message search (FTS5 in SQLite, `includes()` fallback)
- SSE continuous sync (push mode, real-time via Redis)
- Storage quota management (warning/exceeded events)
- Attachment offline queue (presign → upload → confirm)
- Presence caching (realtime events stored locally)
- Multi-tab coordination (BroadcastChannel, last-login-wins)
- E2E encryption (AES-256-GCM + ECDH P-256 + PBKDF2)

**Python SDK:** MemoryStorage + OfflineManager (asyncio, polling sync)
**Go SDK:** MemoryStorage + OfflineManager (goroutine-safe, polling sync)

**New files:**
| File | ~Lines |
|------|--------|
| `sdk/typescript/src/storage.ts` (SQLiteStorage) | +250 |
| `sdk/typescript/src/offline.ts` (SSE, conflict, attachment, presence, quota) | +450 |
| `sdk/typescript/src/multitab.ts` | ~145 |
| `sdk/typescript/src/encryption.ts` | ~280 |
| `sdk/python/prismer/offline.py` | ~430 |
| `sdk/golang/offline.go` | ~550 |
| `src/im/services/conversation.service.ts` | ~200 |
| `src/im/api/sync-stream.ts` | ~130 |
| `src/im/tests/conversation-sync.test.ts` | ~260 |

### v1.7.0 — IM File Transfer ✅ (2026-02-17)

- S3 presigned POST with server-side policy enforcement
- Content validation pipeline (magic bytes, executable scan, compression bomb, MIME mismatch)
- 7 REST endpoints: presign, confirm, multipart init/complete, quota, delete, types
- Dev mode with local filesystem (no S3 required for local dev)
- File message validation in MessageService (`type: "file"` requires confirmed upload)
- CDN URL delivery (`cdn.prismer.app/im/files/...`)
- Credit-based pricing (0.5 credits/MB)
- Quota system (Free: 1GB, Pro: 10GB)
- 54 unit tests (`file-upload.test.ts`) + 13 regression tests (`test-all-apis.ts`)
- Bug fixes: CDN URL protocol prefix, double-delete guard

**New files:**
| File | Lines |
|------|-------|
| `src/im/services/file.service.ts` | ~500 |
| `src/im/services/file-validator.ts` | ~200 |
| `src/im/services/s3.client.ts` | ~80 |
| `src/im/api/files.ts` | ~300 |
| `src/im/tests/file-upload.test.ts` | ~900 |

**Modified files:**
| File | Change |
|------|--------|
| `package.json` | +4 deps (@aws-sdk/client-s3, s3-request-presigner, s3-presigned-post, file-type) |
| `src/im/config.ts` | +s3, cdn, files config sections |
| `src/im/types/index.ts` | +file upload types |
| `src/im/api/routes.ts` | +files router |
| `src/im/server.ts` | +FileService instantiation |
| `src/im/services/message.service.ts` | +file message validation |
| `scripts/test-all-apis.ts` | +13 file upload tests (Group 5) |

### v1.6.0 — Context Cache Local ✅ (2026-02-16)

- Prisma-first local context cache (SQLite dev / MySQL prod)
- Feature flag: `FF_CONTEXT_CACHE_LOCAL`
- Warm migration from backend (no big-bang migration)
- Save route refactored to use adapter
- Parse auto-deposit
- SDK `visibility` parameter (TypeScript, Python, Go)
- Strict user isolation + visibility enforcement
- Batch performance: ~300x improvement (single SQL vs N HTTP)

### v1.5.0 — SDK Webhook + IM v0.3.1 ✅ (2026-02-09)

- SDK PrismerWebhook class (HMAC-SHA256, framework adapters, auto-reply)
- OpenClaw bridge (`createBridge()`)
- IM webhook dispatch to agent endpoints
- Social bindings (Telegram/Discord/Slack)
- Credits system + message bridges

### Platform ✅

- Credits & Billing (frontend-first, `pc_*` tables)
- Dashboard with real data
- Feature-flag switching (`FF_*_LOCAL` env vars)
- API Key management (local `pc_api_keys`)
- Redis pub/sub for cross-Pod broadcasting

---

**Last updated:** 2026-03-16
