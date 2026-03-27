# Memory Layer — Agent 记忆系统设计

**Version:** 0.2
**Date:** 2026-03-09
**Status:** 🚧 M1+M2 已实现，M3+SDK 待实施
**前置:** IM v1.7.1, SDK v1.7.1, Agent Orchestration Phase 0-3

---

## 一、问题陈述

### 当前痛点

AI Agent 在多轮对话/多会话场景下面临三个核心问题：

| 问题 | 现状 | 影响 |
|------|------|------|
| **Context 丢失** | 对话超出上下文窗口后 LLM 遗忘所有内容 | Agent 无法处理长任务 |
| **跨会话失忆** | 每次新会话都是空白状态 | Agent 无法积累知识 |
| **信息召回低效** | 向量检索存在语义漂移（catastrophic forgetting） | 召回质量不可控 |

### 行业趋势

| 方案 | 代表 | 优点 | 缺点 |
|------|------|------|------|
| **向量数据库 RAG** | LangChain, Dify | 语义检索 | 语义漂移、信息碎片化、召回不稳定 |
| **全量 Context 塞入** | 早期 ChatGPT | 简单 | Context Window 有上限 |
| **Markdown 渐进式披露** | Claude Code, opencode | 人可读、可编辑、确定性、可版本控制 | 需要结构化设计 |

**业界共识正在形成：** Markdown 文件 + 渐进式加载 > 纯向量检索。Claude Code 的 `CLAUDE.md` + auto-memory 和 opencode 的 `AGENTS.md` + compaction + todo 是当前最佳实践。

---

## 二、参考分析

### 2.1 Claude Code 记忆模型

```
~/.claude/
├── CLAUDE.md              ← 全局指令（每次对话自动加载）
└── projects/
    └── <project-hash>/
        └── memory/
            └── MEMORY.md  ← 项目记忆（每次自动加载，200行截断）
            └── *.md       ← 按主题组织的详细记忆文件

<project>/
└── CLAUDE.md              ← 项目指令（每次自动加载）
```

**核心机制：**
- **MEMORY.md** 始终加载到 system prompt（200 行截断）
- **详细记忆** 按主题拆分为独立 .md 文件，MEMORY.md 中引用链接
- **写入时机** 由 AI 自主判断（确认的模式、用户偏好、反复出现的问题）
- **人可编辑** 用户可以直接修改 .md 文件纠正错误

### 2.2 opencode 记忆模型

```
Session
├── messages[]              ← 完整消息历史
├── compaction              ← 上下文压缩（summary 替代历史消息）
│   ├── prune()             ← 先删除旧 tool 输出（保留最近 40K tokens）
│   └── process()           ← 用 LLM 生成结构化 summary
├── todo                    ← 任务追踪（session 级别，SQLite 持久化）
└── instruction             ← AGENTS.md / CLAUDE.md 加载（渐进式发现）
```

**关键设计：**

1. **Compaction（上下文压缩）：**
   - 监控 token 使用量，接近上下文窗口限制时触发
   - 先 `prune()` — 删除旧的 tool call 输出（保留最近 40K tokens 的工具调用）
   - 再 `process()` — 用 LLM 生成结构化 summary（Goal / Instructions / Discoveries / Accomplished / Relevant files）
   - Summary 替换历史消息，新的对话轮次基于 summary 继续

2. **Todo（任务追踪）：**
   - Session 级别的任务列表（SQLite `todo` 表）
   - `content`, `status` (pending/in_progress/completed/cancelled), `priority` (high/medium/low)
   - AI 主动使用 TodoWrite 工具管理任务进度
   - 用户可见、可交互

3. **Instruction（渐进式指令加载）：**
   - System 级：项目根目录 `AGENTS.md` / `CLAUDE.md`（始终加载）
   - 目录级：当 Read tool 读取文件时，自动查找并加载该目录的 `AGENTS.md`（如果存在）
   - 避免一次性加载所有指令浪费 context

4. **Storage（持久化）：**
   - JSON 文件存储（`~/.opencode/storage/`）
   - 带 migration 机制的版本管理
   - 读写锁（`Lock.read()` / `Lock.write()`）

### 2.3 PageIndex 评估（LLM-Powered Tree Search）

> 参考 [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex)：一种 LLM 驱动的层级树搜索方案，用于长文档 RAG。

**PageIndex 核心思路：** 对超长文档（数十万 token）构建层级摘要树，每个内部节点是子节点的 LLM 摘要。查询时从根节点开始，LLM 选择最相关的子节点逐层下钻，最终定位到具体页面。

**与 Prismer Memory Layer 的适配度分析：**

| 维度 | PageIndex | Prismer Memory | 结论 |
|------|-----------|---------------|------|
| 目标问题 | 单个超长文档检索 | 多个小型记忆文件管理 | ❌ 不同域 |
| 文档规模 | 10万-100万 token | 单文件 < 4K token, 总量 < 50 文件 | ❌ 规模不匹配 |
| 文档变更频率 | 静态（文档不变） | 高频（每次会话可能更新） | ❌ 树索引维护成本高 |
| LLM 调用 | 查询时 O(log n) 次 | 当前设计 0 次（直接文件加载） | ❌ 增加延迟和成本 |

**结论：PageIndex 方案不适用于 Agent 记忆场景。** 原因：
1. 记忆文件数量少（< 50），不需要层级索引
2. 文件内容高频变更，树索引维护成本 > 直接读取成本
3. LLM 调用引入延迟，与 "快速加载记忆启动会话" 的需求矛盾

**可借鉴的一个模式：** "向 LLM 呈现摘要索引，让它选择要加载的文件" — 这正是我们 MEMORY.md 的设计：MEMORY.md 是所有 topic files 的摘要索引，LLM 读取后自主决定加载哪些 topic files。无需额外基础设施，现有设计已隐含此模式。

### 2.5 OpenClaw Memory 系统（源码分析参考）

> 基于 OpenClaw Swift 源码分析（`SessionData.swift`, memory store 相关文件）。

OpenClaw 的记忆架构采用 **canonical store + derived index** 双层设计：

```
canonical store (source of truth):
├── memory.md          ← 核心记忆（类似 Claude Code 的 MEMORY.md）
├── daily/YYYY-MM-DD/  ← 每日日志（自动归档）
└── bank/              ← 长期知识库（手动沉淀）

derived index (SQLite FTS5):
└── memory.db          ← 全文搜索索引（从 canonical store 自动构建）
```

**retain/recall/reflect 循环：**
- **retain（保留）：** 从会话中提取关键信息 → 写入 memory.md 或 daily log
- **recall（召回）：** 新会话开始时自动加载 memory.md + 根据话题搜索 daily logs
- **reflect（反思）：** 定期 LLM 分析历史日志 → 提炼 opinion evolution → 更新 memory.md

**opinion evolution（观点进化）：** OpenClaw 追踪 agent 对特定话题的观点变化，包含 confidence scoring。例如：
```
Topic: "应该用 React 还是 Vue"
Timeline:
  - 2026-03-01: "倾向 React (confidence: 0.6)"
  - 2026-03-05: "用户项目实践后改为 Vue (confidence: 0.8)"
```

**对 Prismer 的启发：**
1. **daily log 模式**：可以在 `im_memory_files` 中支持 `path: "daily/2026-03-09.md"` 自动日志
2. **derived index**：未来可在 `im_memory_files` 上叠加 MySQL FULLTEXT 索引
3. **opinion evolution**：可以在 Memory flush 时追踪 agent 观点变化（v0.5.0+）

### 2.6 关键设计原则提取

| 原则 | Claude Code | opencode | OpenClaw | 适用于 Prismer |
|------|------------|----------|----------|----------------|
| **Markdown 文件作为记忆载体** | MEMORY.md + topic files | AGENTS.md | memory.md + bank/ | ✅ 人可读、可编辑、可版本控制 |
| **分层加载（渐进式披露）** | MEMORY.md 自动 + 详细文件按需 | System + directory-level | memory.md 自动 + daily/bank 按需 | ✅ 节省 context window |
| **LLM 生成 Summary** | Context compaction (内置) | Compaction template | reflect 循环 | ✅ 长对话不丢信息 |
| **任务追踪** | 无内置 | TodoWrite tool + SQLite | — | ✅ Agent 可追踪进度 |
| **全文搜索** | 无 | 无 | SQLite FTS5 derived index | ⏳ v0.5.0+ MySQL FULLTEXT |
| **观点追踪** | 无 | 无 | opinion evolution + confidence | ⏳ v0.5.0+ 可选 |
| **人可编辑** | 直接改 .md 文件 | 直接改文件 | 直接改 memory.md | ✅ 纠错能力 |
| **本地优先** | 本地文件系统 | 本地 SQLite + JSON | 本地文件 + SQLite | ⚠️ Prismer 需要 Cloud 同步 |

---

## 三、Prismer Memory Layer 设计

### 3.1 架构定位

Prismer 的记忆层与 Claude Code/opencode 有本质区别：**它不是本地 CLI 工具，而是 Cloud 服务**。这意味着：

1. 记忆必须**持久化在 Cloud**（不是本地文件系统）
2. 记忆需要**跨设备、跨 agent 共享**（不是单机单用户）
3. 记忆的写入/读取通过 **API**（不是文件 I/O）

但核心理念完全一致：**Markdown 格式、渐进式加载、LLM 生成 summary、人可编辑**。

### 3.2 三层记忆模型

```
┌─────────────────────────────────────────────────────────────────┐
│                    Memory Architecture                            │
│                                                                   │
│  Layer 1: Working Memory（工作记忆 — 会话级）                       │
│  ├── 当前对话的 context + compaction summary                      │
│  ├── 存储：im_messages + im_compaction_summaries                  │
│  └── 生命周期：会话结束后归档                                       │
│                                                                   │
│  Layer 2: Episodic Memory（情景记忆 — 跨会话）                      │
│  ├── 项目/用户级别的持久化记忆                                      │
│  ├── Markdown 格式：MEMORY.md 主文件 + topic files                │
│  ├── 存储：im_memory_files (Cloud, 类 MEMORY.md)                 │
│  └── 每次会话开始时加载 MEMORY.md（完整内容 + 元数据）               │
│                                                                   │
│  Layer 3: Semantic Memory（语义记忆 — 知识库）                      │
│  ├── 从 episodic memory 提炼的结构化知识                           │
│  ├── 存储：Context Cache (prismer:// URI)                        │
│  └── 按需召回（search/load API）                                   │
│                                                                   │
│  加载策略（渐进式披露）：                                            │
│  System Prompt ← MEMORY.md (always, full content + metadata)    │
│  On demand ← topic files (when relevant topic detected)         │
│  Search ← Context Cache (when explicit knowledge needed)        │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Layer 1: Working Memory（会话级）

**当前对话的上下文管理。** 解决 "对话太长，LLM 遗忘" 问题。

#### Compaction（上下文压缩）

当会话消息接近 token 上限时，IM Server 触发 compaction：

```typescript
// src/im/services/memory.service.ts — 实际实现

interface CompactionSummary {
  id: string;
  conversationId: string;
  summary: string;              // Markdown 格式的 structured summary
  messageRangeStart: string | null; // 被压缩的第一条消息 ID
  messageRangeEnd: string | null;   // 被压缩的最后一条消息 ID
  tokenCount: number;           // summary 的 token 数 (~content.length / 4)
  createdAt: Date;
}

// Compaction 模板（参考 opencode）
const COMPACTION_TEMPLATE = `Summarize the conversation above for continuation by another agent.

## Goal
[What is the user/agent trying to accomplish?]

## Context
[Key decisions, constraints, preferences established]

## Progress
[What has been done, what remains]

## Key Information
[Critical facts, file paths, configurations, API responses that would be needed]`;
```

**触发方式：**
- **当前实现（v1.7.2）：** 手动触发 — Agent/SDK 调用 `POST /api/im/memory/compact` 提交 summary
- **未来（v1.8.0+）：** Cloud 端自动触发（消息 token 数超过阈值 → LLM 生成 summary）
- **Agent 端建议：** OpenClaw plugin 检测到 session token 使用量 > 80% 上限时调用 compact API

**存储（Prisma model，camelCase 字段名）：**

```sql
-- src/im/sql/008_add_memory_layer.sql
CREATE TABLE im_compaction_summaries (
  id                  VARCHAR(30) NOT NULL PRIMARY KEY,
  conversationId      VARCHAR(30) NOT NULL,
  summary             LONGTEXT NOT NULL,
  messageRangeStart   VARCHAR(30) DEFAULT NULL,
  messageRangeEnd     VARCHAR(30) DEFAULT NULL,
  tokenCount          INT NOT NULL DEFAULT 0,
  createdAt           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_compaction_conversation (conversationId)
);
```

#### Prune（修剪旧工具输出）

参考 opencode 的策略：保留最近 N 条消息的工具输出完整，更早的工具输出替换为摘要。

```typescript
// 在消息列表中，距离当前 > PRUNE_PROTECT_TOKENS 的 tool 结果
// 替换为 "[Tool output truncated — see compaction summary]"
const PRUNE_PROTECT_TOKENS = 40_000;
const PRUNE_MINIMUM_TOKENS = 20_000;
```

### 3.4 Layer 2: Episodic Memory（跨会话持久化）

**跨会话的 Markdown 记忆文件。** 解决 "每次新会话都是空白" 问题。

#### 数据模型

```sql
-- src/im/sql/008_add_memory_layer.sql
CREATE TABLE im_memory_files (
  id          VARCHAR(30) NOT NULL PRIMARY KEY,
  ownerId     VARCHAR(30) NOT NULL,
  ownerType   VARCHAR(10) NOT NULL DEFAULT 'agent',
  scope       VARCHAR(50) NOT NULL DEFAULT 'global',
  path        VARCHAR(255) NOT NULL DEFAULT 'MEMORY.md',
  content     MEDIUMTEXT NOT NULL,
  version     INT NOT NULL DEFAULT 1,      -- 乐观锁
  createdAt   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX idx_owner_scope_path (ownerId, scope, path),
  INDEX idx_owner (ownerId, ownerType)
);
```

#### API（8 endpoints，✅ 已实现）

```
POST   /api/im/memory/files                    创建/upsert 记忆文件（同 ownerId+scope+path 则更新）
GET    /api/im/memory/files                    列出记忆文件（元数据，?scope=global&path=MEMORY.md）
GET    /api/im/memory/files/:id                读取记忆文件（含完整内容）
PATCH  /api/im/memory/files/:id                部分更新（append / replace / replace_section + 乐观锁）
DELETE /api/im/memory/files/:id                删除记忆文件
POST   /api/im/memory/compact                  创建 compaction summary（含参与者校验）
GET    /api/im/memory/compact/:conversationId  查询 compaction summaries（含参与者校验）
GET    /api/im/memory/load                     加载 MEMORY.md（完整内容 + totalLines/totalBytes/version/id）
```

#### 加载策略（渐进式披露）

```
Agent 开始新会话
    │
    ├─ 自动加载: MEMORY.md (scope=global, 返回完整内容 + totalLines/totalBytes/version/id)
    │   → SDK/Agent 端根据 totalLines 决定是否截断（推荐 200 行）
    │
    ├─ 按需加载: 当 AI 检测到相关主题 → 读取对应 topic file
    │   例: 讨论 debugging → 加载 debugging.md
    │
    └─ 显式加载: Agent 主动调用 memory API 搜索/读取
        例: prismer_memory_recall tool
```

#### 记忆写入

Agent 通过 tool 写入记忆（参考 Claude Code 的 auto-memory 机制）：

```typescript
// OpenClaw channel plugin 新增 tool
{
  name: "prismer_memory_write",
  description: "Save information to persistent memory for future sessions",
  parameters: {
    path: string,      // "MEMORY.md", "patterns.md", etc.
    operation: "append" | "replace" | "replace_section",
    content: string,   // Markdown 内容
    section?: string,  // replace_section 时指定 ## Section Name
  }
}

{
  name: "prismer_memory_read",
  description: "Read persistent memory files from previous sessions",
  parameters: {
    path?: string,     // 指定文件，默认 MEMORY.md
    scope?: string,    // 指定 scope
  }
}
```

#### 记忆管理规则（注入到 agent system prompt）

```markdown
# Memory Management

You have persistent memory at Prismer Cloud. MEMORY.md is always loaded.

## When to write memory:
- Confirmed patterns across multiple interactions
- User preferences and workflow conventions
- Key architectural decisions and file paths
- Solutions to recurring problems
- When user explicitly asks to remember something

## When NOT to write:
- Session-specific temporary context
- Unverified or speculative conclusions
- Information that duplicates existing knowledge

## How to organize:
- MEMORY.md: concise index (under 200 lines)
- Topic files: detailed notes (patterns.md, debugging.md, etc.)
- Link from MEMORY.md to topic files
```

### 3.5 Layer 3: Semantic Memory（知识库集成）— 与 Context API + Evolution 协同

> **关键问题（2026-03-16 诊断）：** Context Save 的内容只返回 `content_uri`，无法语义检索；Memory files 没有 FULLTEXT 索引；Evolution Gene 的 strategy 需要动态获取上下文但够不着这两层。三层知识存储是断裂的。
>
> 详见 [`docs/EVOLUTION-ENGINE.md`](./EVOLUTION-ENGINE.md) §2.4.3 统一知识层设计。

**打通方案：`prismer_recall` 统一检索 tool**

```
Agent 需要特定知识
    │
    ├─ prismer_recall(query, scope?) → 统一入口（新增）
    │   同时搜索三层：
    │   ├─ im_memory_files: FULLTEXT(content) MATCH query
    │   ├─ im_context_cache: tags LIKE query OR meta MATCH
    │   └─ im_evolution_capsules: signal_key MATCH query
    │   → 返回按相关性排序的混合结果
    │
    ├─ prismer_load(url) → Context Cache 精确匹配（已有）
    │
    ├─ prismer_parse(file) → Document parsing（已有）
    │
    └─ prismer_memory_read(path) → 指定 Memory file（已有）
```

**需要的基础设施改进：**

| 改进 | 目标 | 工作量 |
|------|------|--------|
| `im_memory_files` 加 MySQL FULLTEXT 索引 | Memory 可搜索 | 0.5 天 |
| `im_context_cache` 加 `tags` 字段 | Cache 可按标签检索 | 1 天 |
| `prismer_recall` 统一检索 API + tool | Gene strategy 能动态获取上下文 | 1.5 天 |
| Capsule → Memory 自动沉淀 | 进化知识自动写入 memory | 1 天 |

**不需要向量数据库。** FULLTEXT + 标签搜索 + 信号匹配三路并行已覆盖 90% 场景。向量检索作为 Phase 2 可选增强（`docs/EVOLUTION-ENGINE.md` §2.4.3）。

### 3.6 Memory Flush（记忆沉淀）

每次会话结束前（或 compaction 时），自动将 working memory 中的关键发现沉淀到 episodic memory：

```
会话即将结束 / Compaction 触发
    │
    ├─ LLM 分析当前会话：
    │   "这次会话中有什么值得记住的？"
    │
    ├─ 生成 memory updates:
    │   - 新发现 → append to MEMORY.md 或 topic file
    │   - 纠正 → replace_section in MEMORY.md
    │   - 废弃 → 标记过时
    │
    └─ 写入 im_memory_files (通过 API)
```

这类似于人的 "睡眠整理记忆" 机制——不是实时写入，而是在适当时机批量沉淀。

---

## 四、与现有系统的关系

### 4.1 与 IM 消息系统

Working Memory（compaction summaries）存储在 IM 层，与消息紧密关联。Compaction summary 是特殊类型的消息元数据。

### 4.2 与 Context API

Semantic Memory 复用 Context API（Load/Save），不新建独立的知识存储。Agent 通过 `prismer_load` 获取 web 知识，通过 `context/save` 存储重要内容。

### 4.3 与 Agent Orchestration

- Task 执行结果可自动写入记忆（task.completed → memory flush）
- Scheduler 任务可以触发定期记忆整理（"每天整理一次记忆"）
- Event subscription 可以监听 `memory.updated` 事件

### 4.4 与 E2E 加密

Memory files 属于用户私有数据，遵循 E2E 加密的 Trust Tier 分级：
- Tier 0-1: memory 明文存储（用户自己和受信 agent）
- Tier 2+: memory 可选加密（`summary` 字段作为明文索引面）

---

## 五、实施计划（v1.7.2 范围）

### Phase M1: Working Memory — Compaction Service（1 周）✅

- [x] `im_compaction_summaries` 表（Prisma model + MySQL migration `008`）
- [x] `MemoryService.compact()` — token 计数（~length/4）、summary 存储、模板提供
- [x] Compaction template（Goal / Context / Progress / Key Information）
- [ ] Prune 策略（保留最近 40K tokens 的 tool 输出）— 需 Agent 端配合
- [x] API: `POST /api/im/memory/compact` 手动触发 + `GET /api/im/memory/compact/:conversationId`
- [ ] 消息查询时自动拼接 compaction summary — 需集成到 MessageService

### Phase M2: Episodic Memory — Memory Files（1 周）✅

- [x] `im_memory_files` 表（Prisma model + MySQL migration `008`）
- [x] Memory Files CRUD API（5 endpoints: POST/GET/GET:id/PATCH/DELETE）
- [x] 会话开始时加载 MEMORY.md（`GET /memory/load`，返回完整内容 + totalLines/totalBytes/version/id 元数据，截断由 SDK 端决定）
- [x] 按需加载 topic files（`GET /api/im/memory/files/:id` 读取完整内容）
- [ ] Memory flush（会话结束/compaction 时沉淀关键发现）— 需 Agent 端 + LLM 配合

### Phase M3: Agent Tools（和 M2 同步）

- [ ] OpenClaw plugin: `prismer_memory_write` tool
- [ ] OpenClaw plugin: `prismer_memory_read` tool
- [ ] MCP server: `memory_write` + `memory_read` tools
- [ ] Memory 管理指令注入 agent system prompt

### SDK v1.7.2 Memory 交付物

- [ ] TypeScript SDK: `client.im.memory.*` 方法
- [ ] Python SDK: Memory API client
- [ ] Go SDK: Memory API client
- [ ] OpenClaw plugin: 2 个 memory tools
- [ ] MCP server: 2 个 memory tools

---

## 六、关键决策

### Q1: 为什么不用向量数据库？

**短期不需要。** 原因：
1. Markdown 文件 + 全文搜索足以覆盖 90% 场景
2. 向量检索的 "catastrophic forgetting" 问题严重（旧嵌入被新嵌入冲淡）
3. Markdown 人可读、可编辑、可 debug
4. 如果未来需要语义搜索，可以在现有基础上增量添加 embedding 列

### Q2: Compaction 用哪个 LLM？

**复用 Agent 当前使用的模型。** 如果 Agent 用 Claude，compaction 也用 Claude。Cloud 侧不硬编码模型选择。对于 Cloud 自动触发的 compaction（如 memory flush），使用配置中的默认模型（如 GPT-4o-mini，成本低）。

### Q3: MEMORY.md 截断策略？

**Server 返回完整内容 + 元数据（totalLines/totalBytes），截断由 SDK/Agent 端决定。** Claude Code 的实践证明 200 行（约 4K tokens）足够存储项目的核心记忆。如果超出，应当拆分为 topic files。SDK 可根据 totalLines 在客户端截断（推荐 200 行），保持 API 语义简洁——Server 不做有损处理。

### Q4: 记忆冲突怎么办？（多 agent 写同一个 MEMORY.md）

**乐观锁 + last-write-wins。** `version` 字段防止覆盖。如果冲突，返回 409 Conflict，agent 需要重新读取再写入。对于 topic files，不同 agent 写不同文件（`agent-a-patterns.md`），避免冲突。

---

*Last updated: 2026-03-09 | Phase M1+M2 implemented, 30/30 tests pass | Doc-code alignment verified*
