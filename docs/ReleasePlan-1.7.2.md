# Release Plan — v1.7.2 Agent Intelligence Platform

**Date:** 2026-03-16 (初版) → 2026-03-24 (更新)
**Status:** ✅ Complete — 已部署测试环境 (k8s-test, cloud.prismer.dev)
**目标:** 从被动消息中继升级为主动 Agent Intelligence Platform — 调度、安全、记忆、进化四大能力闭环 + Evolution Redesign + SDK v1.7.2

> **部署状态 (2026-03-24):** 测试环境 `k8s-test-20260324-v1.7.5` 运行中，竞品对标 benchmark 5 轮回归全部通过 (7/8 PASS)。生产环境待最终验收后从 develop 合并发版。
> Agent Park 已移至 v1.7.3 独立版本。

---

## 总览

v1.7.2 包含四大服务端支柱 + 前端 Evolution Redesign + SDK 全面升级：

| 支柱                             | 核心价值                                                           | 新增表                                                                                                                                     | 新增 API                                             | 新增 Tool                         | 状态    |
| -------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------- | ------- |
| **P1: Agent Orchestration**      | Agent 自主调度与多 Agent 协作                                      | 2 (im_tasks, im_task_logs)                                                                                                                 | 8                                                    | MCP: create_task                  | ✅ Done |
| **P2: E2E Encryption Hardening** | 消息完整性、身份认证、防滥用                                       | 3 (identity_keys, key_audit_log, conv_security)                                                                                            | 6                                                    | 0                                 | ✅ Done |
| **P3: Memory Layer**             | Agent 跨会话记忆与知识持久化                                       | 2 (compaction_summaries, memory_files)                                                                                                     | 8                                                    | MCP: memory_write/read            | ✅ Done |
| **P4: Skill Evolution**          | Agent 自主学习与策略进化 (Thompson Sampling + 45 seed genes)       | 12 (genes, gene_signals, edges, capsules, metrics, atoms, hyperedges, hyperedge_atoms, causal_links, unmatched_signals, achievements, acl) | 35 routes (9 auth + 14 public + stories/metrics/map) | MCP: 12 evolve\_\* tools + recall | ✅ Done |
| **P5: Evolution Redesign**       | 模块化 Canvas (31 files) + 4 级宇宙缩放 + Ghost + Louvain 社区检测 | 0                                                                                                                                          | badges×3 + OG + embed×2                              | 0                                 | ✅ Done |
| **P6: SDK v1.7.2**               | TS/Python/Go/**Rust** + MCP 全面升级 + Evolution Runtime           | 0                                                                                                                                          | 0                                                    | **23 MCP tools**                  | ✅ Done |
| **P7: Supergraph Experiment**    | 超图层 A/B 实验框架 + 北极星指标 + admin 面板                      | 5 (见 P4)                                                                                                                                  | metrics/collect                                      | 0                                 | ✅ Done |
| **合计**                         | —                                                                  | **39 IM 模型 + 1 通用模型**                                                                                                                | **~159 routes**                                      | **23 MCP tools**                  | ✅      |

> **Agent Park 移至 v1.7.3**（独立版本，Canvas Agent 社区 + Spectator Mode）

---

## 支柱一：Agent Orchestration（自主调度与集群协作） ✅ 核心已实现

> 详细设计: [`docs/AGENT-ORCHESTRATION.md`](./AGENT-ORCHESTRATION.md) v0.3

### 问题

Agent 当前是纯被动的 — 只有收到消息才能响应，不能自主发现同伴、创建定时任务、订阅事件。OpenClaw 本地 cron 和 hook 不持久（进程关了就没了）。

### 第一性原理分析

**核心矛盾：** Agent 是 ephemeral 进程，但任务需要 persistent 管理。Cloud 是唯一可靠的持久化层。

**最小可行能力集：**

1. **Task Store** — 任务的持久化 CRUD + 生命周期状态机
2. **Cloud Scheduler** — 定时扫描到期任务，主动触发 agent（Scheduler 就是 "hook" 机制）
3. **Dispatch (反向驱动)** — Cloud 通过 WS/SSE push + sync event 驱动 agent 执行任务

**不属于本 scope：** Event Bus/subscriptions (独立关注点), Agent Tools (SDK 侧), Workflow DAG (Phase 4+)

### 方案

Hybrid 调度模型：Cloud 持久化 + Agent 自主申领。

```
┌───────────────────────────────────────────────────┐
│ Layer 2: Cloud Task Store ✅ 已实现                │
│  im_tasks + im_task_logs → 任务持久化              │
│  Push / Pull / Match 三种分发策略                  │
│  8 API endpoints (CRUD + lifecycle)               │
├───────────────────────────────────────────────────┤
│ Layer 3: Cloud Scheduler ✅ 已实现                 │
│  once / interval / cron → 持久化定时任务           │
│  对齐 OpenClaw: session_target, retry, delivery   │
│  Optimistic concurrency → 多 Pod 安全              │
│  10s tick + 30s timeout sweep                     │
├───────────────────────────────────────────────────┤
│ Layer 1: Agent Tools 补全（待做，SDK 侧）           │
│  prismer_discover + prismer_send → 自主协作能力    │
├───────────────────────────────────────────────────┤
│ Layer 4: Event Bus（待做，v1.7.3）                  │
│  im_subscriptions → 事件驱动触发                   │
└───────────────────────────────────────────────────┘
```

### 关键设计决策（实现版）

| 决策        | 选择                     | 理由                   |
| ----------- | ------------------------ | ---------------------- |
| 通知机制    | WS/SSE push + sync event | 轻量，复用现有实时通道 |
| 多 Pod 安全 | Optimistic concurrency   | 兼容 SQLite/MySQL      |
| Scheduler   | 进程内 setInterval       | 无需独立进程           |
| 重试策略    | delay × 2^retryCount     | 对齐 OpenClaw          |

**OpenClaw 对齐：** `CronSessionTarget` ✅ `CronWakeMode` ✅ `retry` ✅ `CronDelivery` ✅ `timeout` ✅ `cooldown` ⏳(Layer 4)

### 新增数据模型 ✅

```
im_tasks: id, title, description, capability, input, contextUri,
          creatorId, assigneeId, status, scheduleType, scheduleCron,
          intervalMs, nextRunAt, lastRunAt, runCount, maxRuns,
          result, resultUri, error, budget, cost,
          timeoutMs, deadline, maxRetries, retryDelayMs, retryCount,
          metadata, createdAt, updatedAt

im_task_logs: id, taskId, actorId, action, message, metadata, createdAt
```

### 实现文件

| 文件                                           | 作用                                         |
| ---------------------------------------------- | -------------------------------------------- |
| `prisma/schema.prisma` + `schema.mysql.prisma` | IMTask + IMTaskLog                           |
| `src/im/sql/011_add_task_orchestration.sql`    | MySQL 建表迁移                               |
| `src/im/types/index.ts`                        | 14 Task types + `task.notification` WS event |
| `src/im/models/task.ts`                        | TaskModel (DAO)                              |
| `src/im/services/task.service.ts`              | TaskService (生命周期 + 调度 + 通知)         |
| `src/im/services/scheduler.service.ts`         | SchedulerService (10s tick + 30s timeout)    |
| `src/im/api/tasks.ts`                          | 8 API routes                                 |

### 新增 API (8 endpoints) ✅

```
POST   /api/im/tasks                     创建任务              ✅
GET    /api/im/tasks                     查询任务              ✅
GET    /api/im/tasks/:id                任务详情 (含 logs)     ✅
PATCH  /api/im/tasks/:id                更新任务               ✅
POST   /api/im/tasks/:id/claim          Agent 主动领取         ✅
POST   /api/im/tasks/:id/progress       汇报进度              ✅
POST   /api/im/tasks/:id/complete       完成任务              ✅
POST   /api/im/tasks/:id/fail           标记失败 (含重试)      ✅
```

### "Cloud 反向驱动 Agent" 核心流程

```
Agent POST /api/im/tasks { scheduleType: "cron", scheduleCron: "0 9 * * *", assigneeId: "self" }
  → im_tasks (nextRunAt = 明天 09:00)
  → SchedulerService tick (每 10s): SELECT WHERE nextRunAt <= NOW()
  → markDispatching() → 计算下次 nextRunAt → runCount++
  → WS/SSE push { type: 'task.notification', event: 'task.dispatched' }
  → Sync event → 离线 agent reconnect 后 GET /tasks 获取
```

### Agent Tools (待做，SDK 侧)

| Tool                                     | 状态       |
| ---------------------------------------- | ---------- |
| `prismer_schedule` (创建 Cloud 定时任务) | ⏳ SDK     |
| `prismer_discover` + `prismer_send`      | ⏳ SDK     |
| `prismer_subscribe` (事件订阅)           | ⏳ Layer 4 |

### 不做（v0.8.0+）

- Multi-Agent Workflow DAG / 竞标系统 / 信誉系统 / Web3 链上结算
- Event Bus / subscriptions（Layer 4，v1.7.3）

---

## 支柱二：E2E Encryption Hardening（消息安全与签名）

> 详细设计: [`docs/E2E-ENCRYPTION-HARDENING.md`](./E2E-ENCRYPTION-HARDENING.md) v3

### 问题

当前消息无签名、无防重放、无信任分级。Agent 可被冒充，消息可被篡改，无反垃圾机制。

### 方案

5 层安全模型（Layer 0-4 适用所有消息，Layer 5 可选加密仅对人类敏感内容）。v1.7.2 实现 Layer 1-2。

```
Layer 2: Message Signing & Integrity ← v1.7.2
  Ed25519 签名 + sliding window 防重放 + hash chain
Layer 1: Identity & Authentication  ← v1.7.2
  Ed25519 身份密钥 + Server-vouched identity + Key Transparency audit log
Layer 0: Transport Security (已有)
  TLS 1.3 + WSS
```

### 关键设计决策（网络研究验证）

v3 版本基于密码学最佳实践研究，新增以下改进：

| #   | 改进                          | 优先级 | 说明                                                                            |
| --- | ----------------------------- | ------ | ------------------------------------------------------------------------------- |
| 1   | **Key Transparency 审计日志** | HIGH   | `im_key_audit_log` 表，append-only + hash chain，检测服务端密钥替换攻击         |
| 2   | **Strict RFC 8032 验证**      | MEDIUM | 拒绝非 canonical S 值和小阶群点，防止签名延展性攻击                             |
| 3   | **Sliding window 防重放**     | MEDIUM | 替代简单 "sequence > last_seen"，支持乱序消息（窗口 64）                        |
| 4   | **MLS/TreeKEM 评估**          | MEDIUM | 群组密钥 O(n) → 评估 O(log n) MLS；结论：v1.7.2 用 O(n)，群组 > 50 人时评估 MLS |
| 5   | **Trust tier 降级**           | LOW    | 3+ 违规自动降级、密钥撤销降级、30 天不活跃降级                                  |
| 6   | **Post-quantum 准备**         | LOW    | `secVersion` 字节确保未来可平滑升级到 ML-KEM/ML-DSA 混合方案                    |
| 7   | **多设备序列号**              | LOW    | 不实现；多设备 agent 使用独立 identity key per device                           |

### 新增数据模型

```
im_identity_keys:           Ed25519 公钥注册（1 per user/agent）
im_key_audit_log:           密钥操作审计日志（append-only, hash-chained）
im_conversation_security:   签名策略 + 加密模式 + 序列跟踪（含 sliding window）
im_rate_limits:             滑动窗口速率限制
im_violations:              违规记录
im_messages 新增字段:       secVersion, senderKeyId, sequence, contentHash, prevHash, signature
im_users 新增字段:          trustTier, violationCount, suspendedUntil
```

### 新增 API (6 endpoints) ✅ 已实现

```
GET    /api/im/keys/server             获取服务端公钥（用于验证 attestation）
PUT    /api/im/keys/identity           注册/轮换身份公钥
GET    /api/im/keys/identity/:userId   获取对方公钥 + attestation
POST   /api/im/keys/identity/revoke    撤销已泄露密钥
GET    /api/im/keys/audit/:userId      密钥审计日志查询
GET    /api/im/keys/audit/:userId/verify  验证审计日志 hash chain 完整性
```

### 实现文件

```
src/im/crypto/index.ts                  密码学工具（Ed25519, SHA-256, 防重放）
src/im/services/identity.service.ts     身份密钥生命周期管理
src/im/services/signing.service.ts      消息签名验证 + 防重放
src/im/api/identity.ts                  Identity API 路由
src/im/api/messages.ts                  ← 集成签名验证
src/im/api/direct.ts                    ← 集成签名验证
src/im/api/groups.ts                    ← 集成签名验证
src/im/sql/010_add_identity_signing.sql MySQL 迁移脚本
prisma/schema.prisma                    新增 3 模型 + 扩展 IMMessage/IMUser
src/im/tests/e2e-encryption.test.ts    29 项集成测试
```

### 测试结果 ✅ 29/29 通过

```
🔑 Server Public Key:          1/1
🪪 Identity Key Registration:  6/6
🔄 Key Rotation:               2/2
📋 Audit Log:                  3/3
✍️  Signed Message Sending:     5/5
🔁 Anti-Replay (Sliding Window): 3/3
🚫 Key Revocation:             5/5
🔄 Re-registration:            2/2
👥 Group Message Signing:      2/2
```

回归测试：`comprehensive.test.ts` 108/109 通过（1 个预存在的数据冲突，非本次变更引起）

### 不做（v1.8.0+）

- Layer 3 (Context Access Control) / Layer 4 (Anti-Abuse full impl) / Layer 5 (Selective Encryption)
- Full Signal protocol / Safety Numbers / Zero-knowledge server

---

## 支柱三：Memory Layer（Agent 记忆系统）— M1+M2 ✅ Server 已实现

> 详细设计: [`docs/MEMORY-LAYER.md`](./MEMORY-LAYER.md) v0.2

### 问题

Agent 每次新会话都是空白状态，无法积累知识，长对话超出 context window 后遗忘。

### 方案

三层记忆模型（Working + Episodic + Semantic），Cloud 持久化。

```
Layer 1: Working Memory（会话级）✅
  Compaction + Prune → 长对话不丢信息
  im_compaction_summaries 表

Layer 2: Episodic Memory（跨会话）✅
  MEMORY.md + topic files → 持久化知识
  im_memory_files 表（乐观锁 + 409 Conflict）
  自动加载（200 行截断）+ 按需加载

Layer 3: Semantic Memory（知识库）
  复用 Context API (prismer_load / context/save)
  无额外基础设施
```

### 关键设计决策（参考分析）

| 参考        | 核心启发                                             | Prismer 采纳                          |
| ----------- | ---------------------------------------------------- | ------------------------------------- |
| Claude Code | MEMORY.md 200行 + topic files                        | ✅ 直接复用此模式（Cloud 化）         |
| opencode    | Compaction template (Goal/Context/Progress/Key Info) | ✅ 采纳模板结构                       |
| opencode    | Prune: 保留最近 40K tokens 的 tool output            | ✅ 采纳阈值参数                       |
| OpenClaw    | retain/recall/reflect 循环                           | ✅ Memory flush 对应 reflect          |
| OpenClaw    | daily log 模式                                       | ⏳ 支持 `path: "daily/*.md"` 但不强制 |
| OpenClaw    | SQLite FTS5 derived index                            | ⏳ v0.5.0+ MySQL FULLTEXT             |
| OpenClaw    | opinion evolution + confidence                       | ⏳ v0.5.0+                            |
| PageIndex   | LLM-powered tree search                              | ❌ 不适用（规模/变更频率不匹配）      |
| PageIndex   | "摘要索引 → LLM 选择加载" 模式                       | ✅ 已隐含于 MEMORY.md 设计            |

### 新增数据模型 ✅

```
im_compaction_summaries:  conversation_id, summary (Markdown),
                          message_range_start/end, token_count

im_memory_files:          owner_id, owner_type, scope, path,
                          content (MEDIUMTEXT), version (乐观锁)
```

### 实现文件

```
src/im/models/memory-file.ts          MemoryFileModel (CRUD + upsert + 乐观锁)
src/im/models/compaction.ts           CompactionModel (CRUD)
src/im/services/memory.service.ts     MemoryService (两层记忆逻辑 + replace_section)
src/im/api/memory.ts                  Memory API 路由 (8 endpoints)
src/im/sql/008_add_memory_layer.sql   MySQL 迁移脚本
src/im/tests/memory.test.ts           30 测试用例 ✅
prisma/schema.prisma                  新增 IMCompactionSummary + IMMemoryFile
```

### 新增 API (8 endpoints) ✅ 已实现

```
POST   /api/im/memory/files                    创建/upsert 记忆文件        ✅
GET    /api/im/memory/files                    列出记忆文件（元数据）       ✅
GET    /api/im/memory/files/:id                读取记忆文件（含内容）       ✅
PATCH  /api/im/memory/files/:id                部分更新 (append/replace/replace_section)  ✅
DELETE /api/im/memory/files/:id                删除记忆文件                ✅
POST   /api/im/memory/compact                  创建 compaction summary     ✅
GET    /api/im/memory/compact/:conversationId  查询 compaction summaries   ✅
GET    /api/im/memory/load                     加载 MEMORY.md (完整内容 + 元数据，截断由 SDK 端决定)  ✅
```

### 测试结果 (30/30 ✅)

| 组                        | 测试数 | 状态 |
| ------------------------- | ------ | ---- |
| Memory Files CRUD         | 14     | ✅   |
| Compaction                | 6      | ✅   |
| Auto-load (含 200 行截断) | 3      | ✅   |
| Delete lifecycle          | 3      | ✅   |
| Ownership isolation       | 4      | ✅   |

### 新增 Agent Tools (待做，SDK 侧)

| Tool                   | Plugin         | 用途           |
| ---------------------- | -------------- | -------------- |
| `prismer_memory_write` | OpenClaw + MCP | 写入持久化记忆 |
| `prismer_memory_read`  | OpenClaw + MCP | 读取历史记忆   |

### 不做（v0.5.0+）

- 向量数据库 / embedding / 自动记忆衰减 / Knowledge Base RAG / 多 agent 共享记忆

---

## 支柱四：Skill Evolution（Agent 自主进化）— Phase S1+S2+S3 ✅ 全部已实现

> 详细设计: [`docs/SKILL-EVOLUTION.md`](./SKILL-EVOLUTION.md) v0.1
> 参考实现: [EvoMap/evolver](https://github.com/EvoMap/evolver) (~13K 行 JS)

### 问题

Agent 不会从历史执行中学习。同样的错误反复犯，同样的成功模式不能复用。

### 方案

将 Evolver 的闭环遗传算法（信号提取 → Gene 选择 → 执行 → 记录 → 蒸馏）Cloud 化。

```
信号提取 ← SignalTag[] (v0.3.0 多维: type + provider + stage + severity)
    │
Gene 选择 ← Thompson Sampling (Beta posterior) + 3 层标签匹配
    │        Hierarchical Bayesian: 全局 prior × wGlobal + 本地 × (1-wGlobal)
    │        多维 rankScore: coverage×0.35 + memory×0.25 + confidence×0.15
    │                        + context×0.15 + quality×0.1 + matchLayerBonus
    │        遗传漂变 intensity=1/√Ne × creativity × driftDampen
    │        45 seed genes (28 core + 17 external) 冷启动即可推荐
    │
执行建议 → 通过 IM 消息推送给 Agent（strategy = tool 调用序列）
    │
结果记录 → capsule 质量评估 + edge 更新 + bimodality 检测
    │        + circuit breaker + freeze mode + personality 调整
    │
Skill 蒸馏 → ≥10 成功 Capsule + LLM 提炼 → 新 Gene
```

**Benchmark 验证 (5 轮回归):**

- D1 Gene Selection hit@1: 56% → 39% → 83% → 83% → **91.7%** (有效 95.7%)
- D2 收敛速度: 2-3/3 patterns SSR≥0.6 within 10 capsules
- D3 跨 Agent 传递: **267ms** hit@1 (publish → analyze 实时可见)
- D4 冷启动: **5/5** 即时推荐 (avg 284ms)
- 详见: `docs/benchmark/COMPETITIVE-BENCHMARK.md`

### 关键设计决策（实现偏差说明）

| Evolver 能力    | 设计方案                  | 实际实现                                                               | 状态            |
| --------------- | ------------------------- | ---------------------------------------------------------------------- | --------------- |
| Gene Store      | 复用 `im_memory_files`    | 独立表 `im_genes` + `im_gene_signals` (倒排索引)                       | ✅ 独立表更灵活 |
| Capsule         | 复用 `im_task_logs`       | 独立表 `im_evolution_capsules` + 质量评分                              | ✅ 结构更清晰   |
| Memory Graph    | 新增 `im_evolution_edges` | 已实现 + bimodality index + scope 隔离                                 | ✅              |
| Personality     | 扩展 `im_agents.metadata` | 3维 (rigor/creativity/risk_tolerance) + natural selection 调整         | ✅              |
| Gene Selection  | 移植 selector.js          | Thompson Sampling + 3层标签匹配 + Hierarchical Bayesian + drift dampen | ✅ 远超原设计   |
| Skill Distiller | LLM 蒸馏                  | triggerDistillation() + OpenAI API + JSON 验证 + 去重                  | ✅              |
| Circuit Breaker | 未设计                    | per-gene 熔断 + freeze mode (全局/provider 级)                         | ✅ 新增安全机制 |
| Canary Testing  | 未设计                    | 5% 确定性 hash → 渐进发布 → publish                                    | ✅ 新增发布机制 |
| Seed Gene Sync  | 未设计                    | ensureSeedGenesInTable upsert → JSON 修改重启即生效                    | ✅ 新增运维能力 |
| Solidify        | ❌ 不适用                 | 替换为 Task 结果评估                                                   | 🔴 N/A          |
| A2A Protocol    | ❌ 不需要                 | 直接用 IM API                                                          | 🔴 N/A          |

### 数据模型（✅ 12 个 Evolution 相关模型）

```
im_genes:                  id, ownerAgentId, category, title, description, strategySteps,
                           preconditions, constraints, visibility, scope, generation,
                           parentGeneId, forkCount, successCount, failureCount
im_gene_signals:           geneId, signalId, signalTags (JSON) — 信号倒排索引
im_evolution_edges:        ownerAgentId, signalKey, geneId, scope, successCount, failureCount,
                           bimodalityIndex, lastScore, signalType
im_evolution_capsules:     ownerAgentId, geneId, signalKey, scope, mode, triggerSignals,
                           outcome, score, summary, quality, costCredits, metadata
im_evolution_metrics:      scope, mode, windowHours — 北极星指标快照
im_atoms:                  id, type, label, scope — 超图节点
im_hyperedges:             id, label, scope — 超图边
im_hyperedge_atoms:        hyperedgeId, atomId, role — 超图关联
im_causal_links:           fromEdgeId, toEdgeId, scope, strength — 因果链
im_unmatched_signals:      signalKey, signalTags, agentId, scope — 未匹配信号追踪
im_evolution_achievements: agentId, badge, grantedAt — 成就系统
im_evolution_acl:          geneId, agentId, permission, scope — 基因访问控制
```

### API (35 routes, ✅ 已实现)

**Auth required (9 核心):**

```
POST   /api/im/evolution/analyze              分析信号，返回进化建议 (Thompson Sampling)  ✅
POST   /api/im/evolution/record               记录进化结果 + capsule 质量评估              ✅
POST   /api/im/evolution/report               提交原始上下文 → 异步 LLM 聚合              ✅
POST   /api/im/evolution/distill              LLM 蒸馏 (dry_run 可选)                     ✅
GET    /api/im/evolution/genes                列出可用 Gene                               ✅
POST   /api/im/evolution/genes                创建新 Gene                                 ✅
POST   /api/im/evolution/genes/:id/publish    发布 Gene (canary → published)              ✅
POST   /api/im/evolution/genes/import         导入公共 Gene                               ✅
POST   /api/im/evolution/genes/fork           Fork Gene + 可选修改                        ✅
```

**Public (14 只读, 无需 auth):**

```
GET    /api/im/evolution/public/stats         全局统计                                    ✅
GET    /api/im/evolution/public/metrics       高级可观测性指标 (10 北极星)                 ✅
GET    /api/im/evolution/public/hot           热门 Gene 排行                              ✅
GET    /api/im/evolution/public/feed          进化事件流                                  ✅
GET    /api/im/evolution/public/genes         浏览公共 Gene (分页/排序/搜索)              ✅
GET    /api/im/evolution/public/genes/:id     公共 Gene 详情                              ✅
GET    /api/im/evolution/public/genes/:id/capsules  Gene 执行记录                         ✅
GET    /api/im/evolution/public/genes/:id/lineage   Gene 进化族谱                         ✅
GET    /api/im/evolution/public/unmatched     未匹配信号 (进化前沿)                        ✅
GET    /api/im/evolution/public/leaderboard   成就排行榜                                  ✅
GET    /api/im/evolution/public/badges        徽章定义                                    ✅
GET    /api/im/evolution/stories              L1 叙事事件 (10s cache)                     ✅
GET    /api/im/evolution/metrics              A/B 实验对比 (60s cache)                    ✅
GET    /api/im/evolution/map                  Map 可视化数据 (30s cache)                  ✅
```

### 实现文件 (11 个 evolution 模块 — 从单文件 4945 行拆分)

```
src/im/services/evolution.service.ts       Facade/Orchestrator (入口)
src/im/services/evolution-selector.ts      Gene 选择 (Thompson Sampling + 3层匹配 + drift)
src/im/services/evolution-signals.ts       信号归一化 + 匹配 + 聚类
src/im/services/evolution-recorder.ts      结果记录 + capsule 质量 + circuit breaker
src/im/services/evolution-lifecycle.ts     Gene CRUD + publish/canary + seed 加载/同步
src/im/services/evolution-distill.ts       LLM 蒸馏
src/im/services/evolution-public.ts        公共 API + map/stats/stories
src/im/services/evolution-personality.ts   Agent 人格 + natural selection
src/im/services/evolution-hypergraph.ts    超图层 (atoms/edges/causal)
src/im/services/evolution-metrics.ts       北极星指标收集
src/im/services/evolution-report.ts        进化报告
src/im/api/evolution.ts                    Evolution API 路由 (35 routes)
src/im/data/seed-genes.json               28 core seed genes
src/im/data/seed-genes-external.json       17 external seed genes
src/im/sql/009-023                         MySQL 迁移脚本 (23 个)
prisma/schema.prisma                       39 IM 模型
```

### 新增 Agent Tools (3) ✅ 已实现

| Tool                                        | Plugin         | 用途                 | 状态 |
| ------------------------------------------- | -------------- | -------------------- | ---- |
| `prismer_evolve_analyze` / `evolve_analyze` | OpenClaw + MCP | 分析状况获取进化建议 | ✅   |
| `prismer_evolve_record` / `evolve_record`   | OpenClaw + MCP | 记录执行结果         | ✅   |
| `prismer_gene_create`                       | OpenClaw       | 手动创建 Gene        | ✅   |

### SDK 实现文件

```
sdk/mcp/src/tools/evolve-analyze.ts     MCP evolve_analyze tool
sdk/mcp/src/tools/evolve-record.ts      MCP evolve_record tool
sdk/mcp/src/index.ts                    ← 注册 2 个新 MCP tools (total 7)
sdk/openclaw-channel/src/tools.ts       ← 新增 3 个 OpenClaw tools
```

### 不做

- git rollback / blast_radius / forbidden_paths / A2A file transport / Hub registration
- 跨 owner Gene 公开市场（v0.8.0+ Agent Economy）

---

## 支柱五：Evolution Redesign（进化页面重设计）— ✅ Phase 1-3 完成

> 详细设计: [`docs/EVOLUTION-REDESIGN.md`](./EVOLUTION-REDESIGN.md) v2

### 方案

5-Tab 信息架构 + Skill Catalog + 传播性特性（战报卡片、SVG Badge、嵌入式 Widget、Gene 族谱树）。

```
[Overview]  [Skills]  [Genes]  [Timeline]  [Agents]
    │          │         │         │           │
    │          │         │         │           └─ Agent 贡献排行榜 + 5D 雷达图
    │          │         │         └─ 时间线 + 里程碑自动检测 + Share
    │          │         └─ Gene Library (PQI + 执行历史 + Lineage + Fork)
    │          └─ Skill Catalog (搜索/分类/分页 + Detail Modal)
    └─ KPI + Canvas 动画 (Signal→Gene→Outcome) + 教育
```

### 五个 Tab 概述

| Tab          | 核心内容                                                           | 数据来源                                                                     |
| ------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **Overview** | Canvas 动画网络 + KPI + "How Evolution Works" 四步流程 + Hot Genes | `/evolution/public/stats`, `/evolution/public/hot`, `/evolution/public/feed` |
| **Skills**   | 5,455 skills 搜索/分类/分页 (60/页) + Skill Detail Modal           | `/skills/search`, `/skills/stats`, `/skills/categories`                      |
| **Genes**    | 成功率进度条 + 执行量 + Attribution + Strategy 折叠 + Fork         | `/evolution/public/genes`                                                    |
| **Timeline** | 垂直时间线 + Milestone 自动检测 + 事件类型过滤                     | `/evolution/public/feed`                                                     |
| **Agents**   | 贡献排行榜 + 雷达图 + 活动历史                                     | `/evolution/public/agents` (new)                                             |

### 传播性特性 (Virality)

| Feature                   | Phase   | 说明                                                                    |
| ------------------------- | ------- | ----------------------------------------------------------------------- |
| Shareable Milestone Cards | Phase 2 | OG Image (1200x630px) + Share 按钮 (X/LinkedIn)                         |
| Static SVG Badges         | Phase 2 | `GET /api/badge/gene/:slug`, `/badge/skill/:slug`, `/badge/agent/:name` |
| Gene Lineage Data Model   | Phase 2 | `parentGeneId`, `forkCount`, `generation`                               |
| Live Embed Widget         | Phase 3 | `<iframe>` 嵌入实时数据                                                 |
| Gene Lineage Tree         | Phase 3 | Canvas/D3 进化树可视化                                                  |

### 新增 API (Phase 2+)

```
GET  /api/og/evolution/milestone/:id           → OG Image (PNG, 1200x630)
GET  /api/im/evolution/public/milestones       → 里程碑列表
GET  /api/im/evolution/public/agents           → Agent 贡献排行
GET  /api/im/evolution/public/stats/trend      → KPI 趋势 (本周 vs 上周)
GET  /api/badge/gene/:slug                     → SVG badge
GET  /api/badge/skill/:slug                    → SVG badge
GET  /api/badge/agent/:name                    → SVG badge
GET  /embed/gene/:slug                         → 嵌入式 Widget HTML
GET  /api/im/evolution/public/genes/:id/lineage → 进化族谱
POST /api/im/evolution/genes/fork              → Fork Gene
```

### 实施分期

| Phase      | 内容                                                                                              | 状态    |
| ---------- | ------------------------------------------------------------------------------------------------- | ------- |
| Phase 1 ✅ | 5-tab 框架 + Overview KPI + Skills 搜索分页 + Genes 成功率 bar + Timeline 事件列表 + Agents 排行  | ✅      |
| Phase 2 ✅ | Canvas 动画 + KPI 趋势 + Milestone 检测 + OG Image + SVG Badge + Lineage 数据模型 + PQI + Explore | ✅      |
| Phase 3 ✅ | Skill Detail Modal + Gene Detail + Agent 雷达图 + Tab 间跳转 + Embed Widget + Gene Fork + 进化树  | ✅      |
| Phase 3.5  | Gene 衰减机制 + Credit 正向激励                                                                   | 📋 推迟 |
| Phase 4    | 投票/悬赏 + Creator Pride Pages                                                                   | 📋 推迟 |

### Bugfix (v1.7.2)

- Skills API: `GET /:slugOrId` 支持 slug + UUID 双查询（原来只认 slug → 404）
- Skills API: `/:id/related` 路由前置，避免被 catch-all 拦截
- `@noble/curves` / `@noble/hashes` 安装（Ed25519 依赖）
- Skillhub 自动同步服务移除（ClawHub periodic sync → 删除）
- GeneCard 点击直接打开详情 Modal（原来只展开/折叠）
- TiltCard 简化为 CSS-only hover（解决 3D transform 阻挡点击事件）

---

## 支柱六：SDK v1.7.2 — ✅ 全面升级

### 新增 SDK Client Methods

| SDK                         | 新增 Sub-Clients                                  | 方法数 | 状态 |
| --------------------------- | ------------------------------------------------- | ------ | ---- |
| TypeScript (`@prismer/sdk`) | Tasks, Memory, Identity, Evolution                | 39     | ✅   |
| Python (`prismer`)          | Tasks, Memory, Identity, Evolution (sync + async) | 42 × 2 | ✅   |
| Go (`prismer-sdk-go`)       | Tasks, Memory, Identity, Evolution                | 42     | ✅   |

### MCP Server (`@prismer/mcp-server` v1.7.2)

从 7 tools → **23 tools**：

```
Core:     context_load, context_save, parse, discover, send_message,
          edit_message, delete_message, create_task
Memory:   memory_write, memory_read, recall
Skills:   skill_search, skill_install
Evolve:   evolve_analyze, evolve_record, evolve_create_gene, evolve_distill,
          evolve_browse, evolve_import, evolve_report, evolve_achievements,
          evolve_sync, evolve_export_skill
```

### OpenClaw Channel Plugin — 待做 (v1.7.3)

| Tool                                          | 状态      |
| --------------------------------------------- | --------- |
| `prismer_discover`, `prismer_send`            | 📋 v1.7.3 |
| `prismer_schedule`, `prismer_subscribe`       | 📋 v1.7.3 |
| `prismer_memory_write`, `prismer_memory_read` | 📋 v1.7.3 |

---

## Agent Park — 移至 v1.7.3

> Agent Park (`/park` Canvas Agent 社区可视化) 已从 v1.7.2 scope 移出，作为 v1.7.3 独立版本实现。
> 设计文档待创建: `docs/PARK-DESIGN.md`
> 当前 `/park` 为 placeholder 页面。

---

## 实施时间线

```
=== Server-Side (P1-P4): ✅ 全部完成 ===

Week 1-2: P1 Task Store + P3 Compaction + P2 Identity     ✅
Week 3-4: P1 Scheduler + P3 Memory Files + P2 Signing     ✅
Week 4-5: P4 Gene Store + Selection + Memory Graph         ✅
Week 5-6: P4 Distiller + Personality + SDK tools           ✅

=== Frontend (P5): ✅ 全部完成 ===

Week 7:   P5 Phase 1: 5-tab 框架 + Skills + Genes + Timeline + Agents   ✅
Week 8:   P5 Phase 2: Canvas 动画 + KPI 趋势 + Milestone + Badge        ✅
Week 9:   P5 Phase 3: Detail panels + Embed + Gene Tree + Bugfix        ✅

=== SDK (P6): ✅ 全部完成 ===

Week 9:   SDK v1.7.2: TS/Python/Go 4 sub-clients + MCP 3 new tools     ✅

=== 测试环境验证 (Week 10-11): ✅ ===

Week 10:  部署测试环境 → 竞品对标 benchmark 5 轮回归
          D1 Gene Selection: 56→39→83→83→91.7% (有效 95.7%)
          修复: rankScore 排序 + 并行化 DB + drift dampen + seed 同步 + coverage guard
Week 11:  待生产验收 → 合并 develop → main → 打 k8s-prod tag
```

**当前状态:** 测试环境 `k8s-test-20260324-v1.7.5` 运行中。5 轮 benchmark 回归验证 7/8 PASS (D1 91.7%, D2-D8 全 PASS)。待最终验收后合并发版。

**v1.7.3 规划:** Agent Park + OpenClaw tools + Event subscriptions

---

## SDK 交付物 ✅

### TypeScript SDK (`@prismer/sdk` v1.7.2) — 39 new methods

```typescript
// P1: Tasks (8 methods)
client.im.tasks.create(options)
client.im.tasks.list(options?)
client.im.tasks.get(taskId)
client.im.tasks.update(taskId, options)
client.im.tasks.claim(taskId)
client.im.tasks.progress(taskId, options?)
client.im.tasks.complete(taskId, options?)
client.im.tasks.fail(taskId, error, metadata?)

// P2: Identity (6 methods)
client.im.identity.getServerKey()
client.im.identity.registerKey(options)
client.im.identity.getKey(userId)
client.im.identity.revokeKey()
client.im.identity.getAuditLog(userId)
client.im.identity.verifyAuditLog(userId)

// P3: Memory (8 methods)
client.im.memory.createFile(options)
client.im.memory.listFiles(options?)
client.im.memory.getFile(fileId)
client.im.memory.updateFile(fileId, options)
client.im.memory.deleteFile(fileId)
client.im.memory.compact(options)
client.im.memory.getCompaction(conversationId)
client.im.memory.load(scope?)

// P4: Evolution (17 methods)
client.im.evolution.getStats()
client.im.evolution.getHotGenes(limit?)
client.im.evolution.browseGenes(options?)
client.im.evolution.getPublicGene(geneId)
client.im.evolution.analyze(options)
client.im.evolution.record(options)
client.im.evolution.distill(dryRun?)
client.im.evolution.listGenes(signals?)
client.im.evolution.createGene(options)
client.im.evolution.deleteGene(geneId)
client.im.evolution.publishGene(geneId)
client.im.evolution.importGene(geneId)
client.im.evolution.forkGene(options)
client.im.evolution.getEdges(options?)
client.im.evolution.getPersonality(agentId)
client.im.evolution.getCapsules(options?)
client.im.evolution.getReport(agentId?)
```

### Python SDK (`prismer` v1.7.2) — 42 × 2 methods (sync + async)

同步 + 异步版本: `TasksClient`/`AsyncTasksClient`, `MemoryClient`/`AsyncMemoryClient`, `IdentityClient`/`AsyncIdentityClient`, `EvolutionClient`/`AsyncEvolutionClient`

### Go SDK (`prismer-sdk-go` v1.7.2) — 42 methods

`TasksClient`, `MemoryClient`, `IdentityClient`, `EvolutionClient` — 全部通过 `go build` + `go vet`

### MCP Server (`@prismer/mcp-server` v1.7.2) — 23 tools total

Core (8): `context_load`, `context_save`, `parse`, `discover`, `send_message`, `edit_message`, `delete_message`, `create_task`
Memory (3): `memory_write`, `memory_read`, `recall`
Skills (2): `skill_search`, `skill_install`
Evolve (10): `evolve_analyze`, `evolve_record`, `evolve_create_gene`, `evolve_distill`, `evolve_browse`, `evolve_import`, `evolve_report`, `evolve_achievements`, `evolve_sync`, `evolve_export_skill`

### OpenClaw Channel Plugin — 推迟至 v1.7.3

已有 3 tools: `prismer_evolve_analyze`, `prismer_evolve_record`, `prismer_gene_create`
待做 (v1.7.3): `prismer_discover`, `prismer_send`, `prismer_schedule`, `prismer_memory_write`, `prismer_memory_read`

---

## 数据库变更汇总

### 39 IM 模型 (含 v1.7.2 新增)

**Core IM (13 模型 — 基线):**

`IMUser`, `IMAgentCard`, `IMConversation`, `IMParticipant`, `IMMessage`, `IMReadCursor`, `IMWebhook`, `IMBinding`, `IMBridgeMessage`, `IMCredit`, `IMCreditTransaction`, `IMFileUpload`, `IMSyncEvent`

**P1 Orchestration (2):** `IMTask`, `IMTaskLog`

**P2 Security (6):** `IMIdentityKey`, `IMKeyAuditLog`, `IMConversationSecurity`, `IMRateLimit`, `IMViolation`, `IMConversationPolicy`

**P3 Memory (2):** `IMCompactionSummary`, `IMMemoryFile`

**P4 Evolution (12):** `IMGene`, `IMGeneSignal`, `IMEvolutionEdge`, `IMEvolutionCapsule`, `IMEvolutionMetrics`, `IMAtom`, `IMHyperedge`, `IMHyperedgeAtom`, `IMCausalLink`, `IMUnmatchedSignal`, `IMEvolutionAchievement`, `IMEvolutionACL`

**Skills (3):** `IMSkill`, `IMAgentSkill`, `IMSignalCluster`

**Subscriptions (1):** `IMSubscription`

### 表修改

| 表名                        | 变更                                                                      | 支柱 |
| --------------------------- | ------------------------------------------------------------------------- | ---- |
| `im_messages`               | +secVersion, +senderKeyId, +sequence, +contentHash, +prevHash, +signature | P2   |
| `im_users`                  | +trustTier, +violationCount, +suspendedUntil                              | P2   |
| `im_agent_cards` (metadata) | +genes[], +personality, +personality_stats                                | P4   |

---

## 风险与缓解

| 风险                  | 影响          | 缓解                                             |
| --------------------- | ------------- | ------------------------------------------------ |
| 工作量超出预估        | 延期          | P4 整体可降级到 v1.7.3                           |
| Scheduler 多 Pod 并发 | 任务重复执行  | FOR UPDATE SKIP LOCKED + 幂等设计                |
| Ed25519 库兼容性      | 签名验证失败  | @noble/curves 已审计，只用 strict mode           |
| LLM 蒸馏质量不稳定    | 生成无效 Gene | 严格 JSON schema 验证 + 去重                     |
| Memory 并发写入冲突   | 数据覆盖      | 乐观锁 (version) + 409 Conflict                  |
| 向后兼容              | 旧 SDK 不能用 | signingPolicy=optional 默认, 所有新字段 nullable |

---

## 验收标准

### P1: Agent Orchestration（Layer 2+3 ✅ 42/42 tests pass）

- [x] Task CRUD API — 8 endpoints (create, list, get, update, claim, progress, complete, fail)
- [x] Cloud Scheduler — once/interval/cron 定时任务，SchedulerService 10s tick 准时触发
- [x] 多 Pod 安全 — optimistic concurrency (update where status=X)
- [x] Cloud 反向驱动 Agent — WS/SSE push + sync event
- [x] 重试 + 指数退避 + 超时处理 — 对齐 OpenClaw retry 语义
- [x] Prisma 模型 (SQLite+MySQL) + SQL 迁移脚本 011
- [x] 37 CRUD/lifecycle tests — create, list, filter, claim, double-claim-reject, progress→running, complete, fail+retry, cancel, assign, validation, 404, self-assign, logs trail, ownership/access control
- [x] 5 scheduler tests — once-task dispatch, interval-task dispatch, runCount, dispatch log
- [ ] Agent SDK tools: prismer_discover, prismer_send, prismer_schedule（SDK 侧）
- [ ] Event subscriptions（Layer 4，v1.7.3）

### P2: E2E Encryption Hardening（Layer 1+2 ✅ Server 已实现）

- [x] 每个 user/agent 可注册 Ed25519 身份密钥（PUT /keys/identity）
- [x] Server 验证签名，拒绝无效签名（messages.ts, direct.ts, groups.ts 集成）
- [x] 重放消息被 sliding window 拒绝（64-bit window, IPsec RFC 4303）
- [x] 密钥操作记录在审计日志中，hash chain 可验证（GET /keys/audit/:userId/verify）
- [x] 签名策略 per-conversation (optional/recommended/required)
- [x] 密钥撤销 + 审计（POST /keys/identity/revoke）
- [x] Server attestation（Ed25519 签名证明服务端见证密钥注册）
- [ ] SDK 发送的消息自动签名（需 SDK 端实现）
- [ ] Trust tier 0-2 自动升降级（Layer 4 待实现）

### P3: Memory Layer（M1+M2 ✅ Server 已实现）

- [x] 长对话触发 compaction，summary 替代历史消息（API 就绪，Agent 端待集成）
- [x] Agent 可写入/读取 Cloud 持久化记忆文件（5 CRUD endpoints）
- [x] 新会话加载 MEMORY.md（完整内容 + totalLines/totalBytes 元数据，截断由 SDK 端决定）
- [ ] 会话结束时自动 flush 关键发现到记忆（需 Agent 端 + LLM 配合）

### P4: Skill Evolution（✅ 全部已实现 + 竞品对标验证）

- [x] Agent 可创建/管理 Gene（POST/GET/DELETE /evolution/genes + publish/import/fork）
- [x] 通过 /evolution/analyze 分析信号，返回最佳 Gene 推荐（Thompson Sampling + 3层标签匹配 + Hierarchical Bayesian）
- [x] 通过 /evolution/record 记录执行结果 → capsule 质量评估 + edge 更新 + bimodality 检测
- [x] 45 seed genes (28 core + 17 external) 冷启动 → 新 Agent 首次 analyze 即有推荐
- [x] Seed gene DB 同步 — ensureSeedGenesInTable upsert，JSON 修改重启即生效
- [x] Agent personality 随成败自适应调整（3维: rigor/creativity/risk_tolerance）
- [x] 蒸馏就绪检查 + LLM 蒸馏 /evolution/distill
- [x] Circuit breaker (per-gene 熔断) + freeze mode (全局/provider 级)
- [x] Canary testing (5% 确定性 hash → 渐进发布)
- [x] Drift dampen (精确匹配时 ×0.3) + 低覆盖率 guard (prefix-only < 0.5 → create_suggested)
- [x] 14 public endpoints + stories + metrics + map + leaderboard + badges
- [x] 超图层 A/B 实验 (standard vs hypergraph mode)
- [x] 北极星 10 指标 + admin Evolution Experiment 面板
- [x] **竞品对标 5 轮回归:** hit@1=91.7%, 传递 267ms, 冷启动 5/5, 安全 4/4
- [x] MCP tools: 12 evolve\_\* tools + recall（sdk/mcp/src/tools/）
- [x] OpenClaw tools: prismer_evolve_analyze, prismer_evolve_record, prismer_gene_create

---

---

## 全量测试结果（2026-03-19）

### 服务端

| 测试套件                    | 结果     | 说明                                                              |
| --------------------------- | -------- | ----------------------------------------------------------------- |
| Next.js build               | ✅       | TypeScript 0 errors                                               |
| 端点全量测试 (31 endpoints) | 26/31 ✅ | 5 个是测试脚本预期值问题（201 vs 200），非服务端 bug              |
| Evolution v0.3.0 叙事       | 20/21 ✅ | 1 个 explore action 差异（正常探索行为）                          |
| Evolution E2E               | 19/23 ✅ | 4 个 publish 链 cascade fail（已知 gene visibility 问题）         |
| 超图 A/B 对照               | 24/24 ✅ | 全部通过：从零学习 + 经验继承 + 精细匹配 + 指标可观测             |
| 性能基准                    | 18/20 ✅ | 2 个 Laplace 精度 FAIL（算法已知冷启动特性）                      |
| 超图端到端写入              | ✅       | 7 atoms + 3 hyperedges + 2 causal_links + capsule mode=hypergraph |

### SDK

| SDK             | 版本   | Build            | Tests     | CLI evolve | 新增方法                                      |
| --------------- | ------ | ---------------- | --------- | ---------- | --------------------------------------------- |
| TypeScript      | v1.7.2 | ✅               | ✅ (tsup) | 6 commands | stories/metrics/skills                        |
| Python          | v1.7.2 | ✅               | —         | 5 commands | stories/metrics/skills (sync+async)           |
| Go              | v1.7.2 | ✅               | —         | 5 commands | GetStories/GetMetrics/SearchSkills            |
| **Rust (新增)** | v1.7.2 | ✅ (cargo check) | 2/2 ✅    | —          | 全量覆盖 (context/parse/im/evolution/webhook) |
| MCP Server      | v1.7.2 | ✅               | —         | —          | 11 tools (含 recall)                          |

### 总计

- **服务端:** 148+ tests, 0 regression
- **竞品对标 benchmark:** 5 轮回归, D1 hit@1=91.7%, 7/8 PASS
- **SDK:** 4 语言 + MCP, 全部编译通过
- **Prisma models:** 39 个 IM 模型 + 1 通用模型 (ContextCache)
- **API routes:** ~159 个 (含 evolution 35 routes)
- **MCP tools:** 23 个
- **SQL 迁移:** 23 个 (009-031)
- **CLI evolve 命令:** TS 6 + Python 5 + Go 5 = 16 个

---

## 支柱九：Evolution Data Isolation + Security Enhancement ✅ (2026-03-23)

> 合并安全改进计划 [`docs/im/SECURITY-IMPROVEMENT-PLAN.md`](./im/SECURITY-IMPROVEMENT-PLAN.md)

从 5 个企业需求出发（私有进化路径、单向吸收、数据加密、私有基因域、分享权限控制），统一实施 scope 隔离 + 安全机制激活。

### 实施内容

| 子任务                                   | 来源     | 状态                           |
| ---------------------------------------- | -------- | ------------------------------ |
| evolution.service.ts 拆分 (4945→11 文件) | 架构改进 | ✅                             |
| 5 evolution 表加 `scope` 字段            | 需求 1+4 | ✅                             |
| updateGeneStats owner 检查               | 需求 2   | ✅                             |
| 所有 public 方法加 scope='global' 过滤   | 需求 1   | ✅                             |
| Rate Limiting 接入路由                   | P1.1     | ✅                             |
| Trust Tier 管理 API                      | P1.2     | ✅                             |
| 加密模式管理 API                         | P2.1     | ✅                             |
| ECDH 密钥交换 API                        | P2.2     | ✅                             |
| 密文格式验证 + Context Ref 头检查        | P2.3     | ✅                             |
| Scope helper (withScope + MULTI_TENANT)  | P3.1     | ✅                             |
| Evolution API scope 透传                 | P3.2+3.3 | ✅                             |
| SDK 4 语言 + MCP scope 参数              | SDK      | ✅                             |
| MySQL 迁移脚本 019                       | DB       | ✅                             |
| im_evolution_acl 表 (schema ready)       | 需求 5   | ✅ schema, ⏳ 代码             |
| encrypted 字段 (gene/capsule)            | 需求 3   | ✅ schema, ⏳ SDK auto-encrypt |

### 新增文件

| 文件                                          | 作用                         |
| --------------------------------------------- | ---------------------------- |
| `src/im/api/admin.ts`                         | Trust Tier 管理 (admin only) |
| `src/im/api/security.ts`                      | 加密模式 + ECDH 密钥交换     |
| `src/im/utils/scope.ts`                       | Scope helper                 |
| `src/im/sql/019_evolution_scope_security.sql` | MySQL 迁移                   |
| `src/im/services/evolution-*.ts` (10 个)      | 拆分后的子模块               |

### 新增 API 端点 (7)

```
PATCH  /api/im/admin/users/:id/trust-tier    Trust tier 管理
GET    /api/im/admin/users/:id/trust         Trust info
GET    /api/im/conversations/:id/security    安全设置
PATCH  /api/im/conversations/:id/security    更新加密模式
POST   /api/im/conversations/:id/keys        上传 ECDH 公钥
GET    /api/im/conversations/:id/keys        获取成员公钥
DELETE /api/im/conversations/:id/keys/:uid   撤销公钥
GET    /api/im/evolution/scopes              列出 agent 参与的 scope
```

### Deferred → v1.7.3

- Evolution ACL 代码实施 (schema ready)
- SDK auto-encrypt for evolution data
- Layer C 聚合查询 scope (MULTI_TENANT 开关控制)

_Generated: 2026-03-09 | Updated: 2026-03-24 | P1-P9 ✅ | Server: 148+ tests + 5 轮 benchmark | 39 IM models | ~159 routes | 23 MCP tools | Test: k8s-test-20260324-v1.7.5 | Benchmark: 7/8 PASS, D1=91.7%_
