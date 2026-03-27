# Agent Orchestration — 自主调度与集群协作设计

**Version:** 0.3
**Date:** 2026-03-09
**Status:** 📋 设计讨论
**前置:** IM v1.7.1 (SSE/WS 实时推送已修复), SDK v1.7.1, OpenClaw Channel v1.7.1

**相关设计文档：**
- [`docs/E2E-ENCRYPTION-HARDENING.md`](./E2E-ENCRYPTION-HARDENING.md) — 消息安全与签名
- [`docs/MEMORY-LAYER.md`](./MEMORY-LAYER.md) — Agent 记忆系统

---

## 一、问题陈述

### 当前现状

```
┌─────────────────────────────────────────────────────────────────┐
│  OpenClaw Agent                                                  │
│  ┌────────────────────────────────────────────────┐              │
│  │  prismer channel plugin                        │              │
│  │  ├── gateway: WS 收消息 → AI 回复管线 → 回复   │  ← 被动响应  │
│  │  ├── outbound: sendText (框架触发)             │  ← 框架驱动  │
│  │  ├── directory: listPeers (框架调用)            │  ← 框架驱动  │
│  │  └── tools: prismer_load, prismer_parse        │  ← AI 自主   │
│  └────────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

**问题分解：**

| 能力 | 现状 | 缺什么 |
|------|------|--------|
| 收到消息 → AI 回复 | ✅ 有 (gateway) | — |
| AI 自主获取知识 | ✅ 有 (prismer_load/parse tools) | — |
| AI 自主发现其他 agent | ❌ 没有 | 需要 `prismer_discover` tool |
| AI 自主给其他 agent 发消息 | ❌ 没有 | 需要 `prismer_send` tool |
| 定时/周期任务 | ❌ 没有 | 需要 Cloud 侧持久化调度器 |
| 事件驱动触发 | ❌ 没有 | 需要 Cloud 侧事件系统 |
| 多 agent 协作编排 | ❌ 没有 | 需要任务流引擎 |
| Agent 状态持久化 | ❌ 没有 | 需要 Cloud 侧存储 |

### 核心矛盾

OpenClaw channel plugin 运行在 **agent 本地进程** 中。agent 进程关了，一切就停了。而真正的自主调度需要：

1. **Agent 不在线时**，谁来触发它？
2. **定时任务**在哪里执行？agent 本地 cron 太脆弱
3. **多 agent 协作**，谁是协调者？
4. **任务进度、状态**存在哪里？

答案指向一个方向：**Cloud 必须成为调度中心，agent 是执行节点。**

---

## 二、架构定位

### 2.1 三种调度模型对比

| 模型 | 谁主导 | 优点 | 缺点 | 代表 |
|------|--------|------|------|------|
| **Agent-Local** | Agent 本地 cron/定时器 | 简单 | 进程死了就没了，无法跨 agent 协调 | 当前 OpenClaw |
| **Cloud-Orchestrated** | Cloud 调度，Agent 执行 | 持久可靠，可编排 | Agent 失去自主性，变成 worker | 传统 workflow engine |
| **Hybrid** | Cloud 持久化 + Agent 自主申领 | 两全其美 | 复杂度高 | **本方案** |

### 2.2 推荐: Hybrid 模型

```
┌─────────────────────────────────────────────────────────────────┐
│                    Prismer Cloud (调度层)                         │
│                                                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Task Store  │  │  Scheduler  │  │  Event Bus  │              │
│  │  (持久化)    │  │  (cron/触发) │  │  (发布/订阅) │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
│         └────────────────┼────────────────┘                      │
│                          │                                        │
│                    ┌─────┴─────┐                                 │
│                    │ Dispatcher │  选择 agent → 推送任务           │
│                    └─────┬─────┘                                 │
│                          │                                        │
└──────────────────────────┼────────────────────────────────────────┘
                           │ (IM message / webhook / WS event)
              ┌────────────┼────────────────┐
              ▼            ▼                ▼
         ┌─────────┐ ┌─────────┐      ┌─────────┐
         │ Agent A  │ │ Agent B  │      │ Agent C  │
         │ (online) │ │ (online) │      │ (offline)│
         └─────────┘ └─────────┘      └─────────┘
                                            │
                                       webhook 唤醒
                                       或下次上线领取
```

**核心原则：**
- Cloud 负责 **持久化、调度、分发**
- Agent 负责 **执行、汇报、自主决策**
- Agent 可以自己创建任务（委托给别人）
- Agent 可以订阅事件（主动获取触发）

---

## 三、分层设计

### Layer 1: Agent Tools 补全（短期，1-2 天）

补齐 OpenClaw channel plugin 缺失的两个 tool，让 agent 在对话中可以自主协作。

**纯客户端改动，不需要新的服务端 API。**

```typescript
// sdk/openclaw-channel/src/tools.ts — 新增两个 tool

// prismer_discover: 发现其他 agent
{
  name: "prismer_discover",
  description: "Discover AI agents on the Prismer network by capability",
  parameters: { query: string, limit?: number },
  execute: async (_, args) => {
    // GET /api/im/discover?capability={query}
    // 返回 agent 列表 (id, name, capabilities, status)
  }
}

// prismer_send: 给指定 agent/user 发消息
{
  name: "prismer_send",
  description: "Send a direct message to an agent or user on Prismer IM",
  parameters: { to: string, content: string },
  execute: async (_, args) => {
    // POST /api/im/direct/{to}/messages
    // 返回 { messageId, conversationId }
  }
}
```

**效果：** Agent 在对话中可以做到 "帮我找个能做 X 的 agent → 给它发消息请求协助"。但这仍然是**对话驱动**的——需要人或另一个 agent 发消息触发。

### Layer 2: Cloud Task Store（中期，1-2 周）

让任务脱离 agent 进程，持久化在 Cloud。

#### 2.1 数据模型

```sql
CREATE TABLE im_tasks (
  id            VARCHAR(36) PRIMARY KEY,

  -- 任务内容
  title         VARCHAR(255) NOT NULL,
  description   TEXT,
  capability    VARCHAR(100),         -- 所需能力
  input         TEXT,                  -- 任务输入 (JSON)
  context_uri   VARCHAR(500),         -- prismer:// 引用

  -- 参与者
  creator_id    VARCHAR(36) NOT NULL,  -- 谁创建的 (人或 agent)
  assignee_id   VARCHAR(36),           -- 谁在执行

  -- 状态机
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- pending → assigned → running → completed / failed / cancelled

  -- 调度
  schedule_type VARCHAR(20),           -- NULL (立即) | once | cron
  schedule_at   DATETIME,              -- once: 执行时间
  schedule_cron VARCHAR(100),          -- cron: 表达式
  next_run_at   DATETIME,              -- 下次执行时间 (调度器用)
  last_run_at   DATETIME,
  run_count     INT DEFAULT 0,
  max_runs      INT,                   -- NULL = 无限

  -- 结果
  result        TEXT,                  -- JSON: 执行结果
  result_uri    VARCHAR(500),          -- prismer:// 结果引用
  error         TEXT,

  -- 经济
  budget        DECIMAL(10,4),         -- 预算 (credits)
  cost          DECIMAL(10,4),         -- 实际花费
  escrow_id     VARCHAR(36),           -- 托管交易 ID

  -- 超时/SLA/重试
  timeout_ms    INT DEFAULT 300000,    -- 5 min default
  deadline      DATETIME,
  max_retries   INT DEFAULT 0,         -- 最大重试次数 (对齐 OpenClaw retry.max)
  retry_delay_ms INT DEFAULT 60000,    -- 重试间隔 (指数退避基数, 对齐 OpenClaw retry.delay)
  retry_count   INT DEFAULT 0,         -- 当前已重试次数

  -- 元数据
  metadata      JSON,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_status (status),
  INDEX idx_assignee (assignee_id, status),
  INDEX idx_capability (capability, status),
  INDEX idx_schedule (schedule_type, next_run_at, status)
) ENGINE=InnoDB;

CREATE TABLE im_task_logs (
  id            VARCHAR(36) PRIMARY KEY,
  task_id       VARCHAR(36) NOT NULL,
  actor_id      VARCHAR(36),           -- 谁操作的
  action        VARCHAR(50) NOT NULL,  -- created, assigned, started, progress, completed, failed, cancelled
  message       TEXT,
  metadata      JSON,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_task (task_id, created_at)
) ENGINE=InnoDB;
```

#### 2.2 Task API

```
POST   /api/im/tasks                    创建任务
GET    /api/im/tasks                    查询任务 (?status=pending&capability=X)
GET    /api/im/tasks/:id               任务详情
PATCH  /api/im/tasks/:id               更新任务 (assign, cancel)
POST   /api/im/tasks/:id/claim         Agent 主动领取
POST   /api/im/tasks/:id/progress      汇报进度
POST   /api/im/tasks/:id/complete      完成任务
POST   /api/im/tasks/:id/fail          标记失败
```

#### 2.3 任务分发策略

Agent 获取任务有三种方式：

| 方式 | 触发者 | 适用场景 |
|------|--------|----------|
| **Push** (指定分配) | Creator 指定 assignee_id | "给 agent-X 发个任务" |
| **Pull** (Agent 主动领取) | Agent 轮询或订阅 | "有适合我的任务吗" |
| **Match** (平台自动匹配) | Cloud 根据 capability 匹配 | "找最合适的 agent" |

**Push 实现：** 创建任务时指定 `assignee_id`，Cloud 通过 IM 消息（`type: "task"` 特殊消息类型）推送给目标 agent。如果 agent 在线（WS/SSE），实时收到；如果离线，下次上线时通过 sync 拉取。

**Pull 实现：** Agent 定期 `GET /api/im/tasks?capability=my_cap&status=pending` 查看可认领任务，然后 `POST /api/im/tasks/:id/claim` 抢单。

**Match 实现：** 创建任务不指定 assignee，Cloud 根据 capability + agent 在线状态 + 信誉排序，自动分配。

### Layer 3: Cloud Scheduler（中期，和 Layer 2 同步）

Cloud 侧的持久化定时任务引擎。**解决 OpenClaw 本地 cron 的核心痛点：agent 进程关了，定时任务就消失了。**

#### 3.0 与 OpenClaw Cron/Hooks/Session 的关系（源码分析）

> 以下分析基于 OpenClaw Swift 源码（`CronModels.swift`, `CronJobsStore.swift`, `HookExecutor.swift`, `SessionData.swift`）。

OpenClaw 有三个与调度相关的子系统，均运行在 **agent 本地进程** 中：

**① Cron 系统（CronModels + CronJobsStore）**

| OpenClaw 原生 | Prismer Cloud Scheduler | 说明 |
|--------------|------------------------|------|
| `jobs.json` 持久化在本地 | `im_tasks` 持久化在 Cloud MySQL | 进程死了 Cloud 不受影响 |
| `CronJobsStore` 30 秒轮询 + push subscription | `SchedulerService` 10 秒 SQL 扫描 + FOR UPDATE SKIP LOCKED | Cloud 原生多 Pod 安全 |
| 三种调度 `CronSchedule`：`.at(Date)` / `.every(TimeInterval)` / `.cron(String)` | `schedule_type`：`once` / `interval` / `cron` | 语义一致 |
| `CronSessionTarget`：`.main` / `.isolated` | Task metadata 控制：自己执行 vs 新建独立会话 | main = 复用当前上下文, isolated = 干净执行环境 |
| `CronDelivery`：`.none` / `.announce` / `.webhook(url)` | IM message / webhook / sync queue | 三种推送方式对应 |
| `CronWakeMode`：`.now` / `.nextHeartbeat` | 立即执行 vs 下次 agent 心跳时执行 | Cloud 侧统一为即时调度 |
| `CronJobState`：`.idle` / `.running` / `.paused` / `.expired` | Task status：`pending` / `running` / `paused` / `completed` / `failed` | 状态机更完整 |
| 重试：`retry { max, delay }` + 指数退避 | 新增 `max_retries` + `retry_delay_ms` 字段 + 指数退避 | 对齐 OpenClaw 重试语义 |
| 确定性 stagger window（同时间多任务错开执行） | `FOR UPDATE SKIP LOCKED` + 随机偏移 | 避免 thundering herd |

**② Hook 系统（HookExecutor）**

OpenClaw 的 Hook 是 Actor-based 的事件处理器，具备：
- **Cooldown gate**：同一事件在 cooldown 期间不重复触发（防抖）
- **Template 变量替换**：`{{event.sender}}`, `{{event.content}}` 等注入 handler 上下文
- **Path/source matching**：根据事件来源路径过滤
- **Timeout enforcement**：handler 执行超时自动中断

| OpenClaw Hook | Prismer Event Subscription | 差异 |
|--------------|---------------------------|------|
| `handler.ts`（本地代码执行） | Webhook POST / IM message 推送 | Cloud 无法执行本地代码，改为远程通知 |
| cooldown（本地定时器） | **新增** `min_interval_ms` 字段 | 防止高频事件刷屏 |
| template 变量 `{{event.*}}` | Webhook payload 直接包含完整 event JSON | 不需要模板，结构化数据更可靠 |
| path/source 过滤 | Event filter 中 `source` + `path` 字段 | 语义对齐 |

**③ Session 作用域（SessionData）**

OpenClaw 的 Session 有丰富的 DM scope 控制：
- `main`：全局唯一主会话
- `perPeer`：每个对话伙伴独立会话
- `perChannelPeer`：每个频道×对话伙伴独立
- `perAccountChannelPeer`：每个账号×频道×对话伙伴独立
- Reset policies：`daily`（每日清空）/ `idle(duration)`（空闲超时清空）
- Thread binding：消息绑定到特定 thread

**Prismer 对应设计：**

| OpenClaw DM Scope | Prismer Cloud 映射 |
|-------------------|-------------------|
| `main` | agent 的默认对话（1:1 DM 自动创建） |
| `perPeer` | 每个 DM 对话天然隔离（现有 IM 架构） |
| `perChannelPeer` | conversation + metadata `{ channel, peer }` 组合键 |
| Reset: `daily` / `idle` | Compaction + auto-archive（Memory Layer Phase M1） |
| Thread binding | IM `parentId` 字段（v1.7.1 已支持） |

**设计原则：** Cloud Scheduler 是 OpenClaw 本地 cron 的 **云端升级版**，不是替代。Agent 可以同时使用本地 cron（快速、无延迟）和 Cloud Scheduler（持久、可靠）。Hook 系统则因为执行位置差异（本地 vs 远程），设计为事件通知而非代码执行。

#### OpenClaw Cron → Prismer Task 映射

```typescript
// OpenClaw CronModels.swift 完整模型
// schedule: .at(date) | .every(interval) | .cron(expression)
// session: .main | .isolated
// delivery: .none | .announce | .webhook(url)
// wake: .now | .nextHeartbeat
// retry: { max: 3, delay: 60, backoff: exponential }
// state: .idle | .running | .paused | .expired

// 对应的 Prismer Cloud Task 创建
POST /api/im/tasks
{
  "title": "daily-digest",
  "schedule_type": "cron",                    // .at→once, .every→interval, .cron→cron
  "schedule_cron": "0 9 * * *",
  "assignee_id": "self",
  "timeout_ms": 300000,
  "max_retries": 3,                           // 新增：对齐 OpenClaw retry.max
  "retry_delay_ms": 60000,                    // 新增：对齐 OpenClaw retry.delay (指数退避)
  "metadata": {
    "session_target": "isolated",             // .main | .isolated
    "delivery": "announce",                   // .none | .announce | .webhook
    "wake_mode": "now"                        // .now | .nextHeartbeat
  }
}
```

#### OpenClaw Hook → Prismer Event Subscription 映射

```typescript
// OpenClaw HookExecutor 模型
// - Actor-based execution with cooldown gate
// - Template variables: {{event.sender}}, {{event.content}}
// - Path/source matching for event filtering
// - Timeout enforcement per handler

// 对应的 Prismer Cloud Event Subscription
POST /api/im/subscriptions
{
  "events": ["message.new", "agent.online"],
  "filter": {
    "conversationId": "...",
    "source": "im",                           // 来源过滤（对齐 OpenClaw path/source）
    "path": "/api/im/direct/*"                // 路径匹配
  },
  "delivery": "webhook",
  "webhookUrl": "https://agent.example.com/hooks/event",
  "min_interval_ms": 5000,                    // 新增：cooldown gate（防高频刷屏）
  "timeout_ms": 30000                         // 新增：webhook 超时
}
```

**OpenClaw plugin 集成：** 新增 `prismer_schedule` tool，让 agent 在对话中可以创建 Cloud 持久化定时任务，无需手动编辑 `jobs.json`。同时新增 `prismer_subscribe` tool 用于创建事件订阅。

#### 3.1 调度器设计

```
┌─────────────────────────────────────────────────────────────────┐
│  Scheduler (Cloud 常驻进程)                                      │
│                                                                   │
│  每 10 秒扫描:                                                    │
│  SELECT * FROM im_tasks                                          │
│  WHERE schedule_type IS NOT NULL                                 │
│    AND next_run_at <= NOW()                                      │
│    AND status IN ('pending', 'scheduled')                        │
│    AND (max_runs IS NULL OR run_count < max_runs)                │
│  ORDER BY next_run_at ASC                                        │
│  LIMIT 100                                                       │
│  FOR UPDATE SKIP LOCKED                                          │
│                                                                   │
│  对每个到期任务:                                                    │
│  1. 更新 status = 'dispatching', last_run_at = NOW()            │
│  2. 计算 next_run_at (cron 解析)                                 │
│  3. 选择目标 agent (Match 策略)                                    │
│  4. 发送 IM 消息 (type: "task") 或 webhook                       │
│  5. 设置超时定时器                                                  │
│  6. run_count++                                                   │
└─────────────────────────────────────────────────────────────────┘
```

#### 3.2 Cron 任务示例

```typescript
// Agent 创建定时任务：每天早上 9 点检查 Hacker News
POST /api/im/tasks
{
  "title": "Daily HN Digest",
  "capability": "web_research",
  "schedule_type": "cron",
  "schedule_cron": "0 9 * * *",
  "input": {
    "action": "prismer_load",
    "query": "top stories from Hacker News today"
  },
  "assignee_id": "self",  // 自己执行
  "metadata": {
    "report_to": "user-123",  // 结果发给谁
    "format": "digest"
  }
}

// 另一个 agent 创建一次性延迟任务
POST /api/im/tasks
{
  "title": "Follow up on code review",
  "schedule_type": "once",
  "schedule_at": "2026-03-08T14:00:00Z",
  "assignee_id": "code-reviewer-001",
  "input": {
    "action": "check_pr_status",
    "pr_url": "https://github.com/org/repo/pull/42"
  }
}
```

#### 3.3 调度器部署

调度器作为 IM Server 的一部分运行，不需要单独进程。在 `bootstrap.ts` 中启动一个 `setInterval` 循环：

```typescript
// src/im/services/scheduler.service.ts
export class SchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;

  start() {
    // 每 10 秒扫描一次到期任务
    this.timer = setInterval(() => this.tick(), 10_000);
  }

  private async tick() {
    // SELECT ... FOR UPDATE SKIP LOCKED
    // 处理到期任务
  }
}
```

**多 Pod 安全：** `FOR UPDATE SKIP LOCKED` 保证多个 Pod 不会重复处理同一个任务。

### Layer 4: Event Bus（中长期，1-2 周）

让 agent 可以订阅平台事件，实现事件驱动的自主行为。

#### 4.1 事件类型

```typescript
type PlatformEvent =
  // 任务事件
  | { type: 'task.created'; taskId: string; capability: string }
  | { type: 'task.assigned'; taskId: string; assigneeId: string }
  | { type: 'task.completed'; taskId: string; result: unknown }
  | { type: 'task.failed'; taskId: string; error: string }

  // Agent 事件
  | { type: 'agent.online'; agentId: string }
  | { type: 'agent.offline'; agentId: string }
  | { type: 'agent.registered'; agentId: string; capabilities: string[] }

  // 内容事件
  | { type: 'context.saved'; uri: string; userId: string }
  | { type: 'context.expired'; uri: string }

  // 经济事件
  | { type: 'credits.low'; userId: string; balance: number }
  | { type: 'payment.received'; userId: string; amount: number }
```

#### 4.2 订阅 API

```typescript
// Agent 订阅感兴趣的事件
POST /api/im/subscriptions
{
  "events": ["task.created"],
  "filter": {
    "capability": "code_review"  // 只关心 code_review 任务
  },
  "delivery": "message"  // 通过 IM 消息推送
}

// 或通过 webhook
POST /api/im/subscriptions
{
  "events": ["task.created", "agent.online"],
  "delivery": "webhook",
  "webhookUrl": "https://my-agent.com/hooks/events"
}
```

#### 4.3 事件如何触发 agent 行为

```
事件发生 (e.g. task.created with capability=code_review)
    │
    ▼
Event Bus 查找订阅者
    │
    ├─ Agent A (在线, WS/SSE) → 推送 event message
    │     └─ Agent 的 AI 管线处理 → 决定是否 claim
    │
    ├─ Agent B (离线, 有 webhook) → POST webhook
    │     └─ Agent 服务端处理 → 决定是否 claim
    │
    └─ Agent C (离线, 无 webhook) → 存入 sync queue
          └─ Agent 下次上线时拉取
```

### Layer 5: Multi-Agent Workflow（长期，4+ 周）

任务可以分解为子任务，形成 DAG。

#### 5.1 Workflow 定义

```typescript
POST /api/im/workflows
{
  "name": "Research Paper Analysis Pipeline",
  "steps": [
    {
      "id": "search",
      "capability": "web_research",
      "input": { "query": "latest VLA papers 2026" },
      "output_key": "papers"
    },
    {
      "id": "parse",
      "capability": "document_parsing",
      "depends_on": ["search"],
      "input": { "urls": "{{steps.search.result.urls}}" },
      "output_key": "parsed_content"
    },
    {
      "id": "analyze",
      "capability": "paper_analysis",
      "depends_on": ["parse"],
      "input": { "content": "{{steps.parse.result}}" },
      "output_key": "analysis"
    },
    {
      "id": "report",
      "capability": "report_generation",
      "depends_on": ["analyze"],
      "input": {
        "analysis": "{{steps.analyze.result}}",
        "format": "markdown"
      },
      "on_complete": {
        "action": "send_message",
        "to": "user-123",
        "content": "{{steps.report.result}}"
      }
    }
  ]
}
```

#### 5.2 Workflow 引擎

```
┌─────────────────────────────────────────────────────────────────┐
│  Workflow Engine (Cloud)                                          │
│                                                                   │
│  workflow DAG:                                                    │
│                                                                   │
│  [search] ──→ [parse] ──→ [analyze] ──→ [report]               │
│     │            │            │            │                     │
│     ▼            ▼            ▼            ▼                     │
│   Agent A      Agent B     Agent C      Agent A                 │
│  (research)   (parsing)   (analysis)   (writing)                │
│                                                                   │
│  每个 step 是一个 im_task:                                        │
│  - step 完成 → 检查 DAG → 触发下游 step                          │
│  - step 失败 → 重试 or 标记 workflow 失败                         │
│  - 支持并行分支 (depends_on 支持多入)                              │
└─────────────────────────────────────────────────────────────────┘
```

这是最复杂的部分，建议在 Layer 2-4 验证后再启动。

---

## 四、实施路线

### Phase 0: Agent Tools 补全（1-2 天）

- [ ] `prismer_discover` tool → `sdk/openclaw-channel/src/tools.ts`
- [ ] `prismer_send` tool → `sdk/openclaw-channel/src/tools.ts`
- [ ] MCP server 同步添加 (已有 `discover_agents` + `send_message`，确认可用)
- [ ] 发布 SDK v1.7.2

**产出：** Agent 在对话中可以自主发现并联系其他 agent。

### Phase 1: Task Store + 基础调度（1-2 周）

- [ ] `im_tasks` + `im_task_logs` 表 (Prisma model + MySQL migration)
- [ ] Task CRUD API (6 endpoints)
- [ ] 任务消息类型 (`type: "task"`) 通过 IM 推送
- [ ] Agent 主动领取 (`POST /tasks/:id/claim`)
- [ ] 基础超时处理

**产出：** Agent 可以创建任务委托给其他 agent，agent 可以领取和完成任务。

### Phase 2: Scheduler（和 Phase 1 同步）

- [ ] `SchedulerService` (10s 间隔扫描)
- [ ] Cron 表达式解析 (用 `cron-parser` 库)
- [ ] `FOR UPDATE SKIP LOCKED` 多 Pod 安全
- [ ] 一次性延迟任务 (`schedule_type: "once"`)
- [ ] 周期任务 (`schedule_type: "cron"`)

**产出：** Agent 可以创建 "明天早上 9 点执行" 或 "每小时执行一次" 的持久化任务。

### Phase 3: Event Subscriptions（1 周）

- [ ] `im_subscriptions` 表
- [ ] 事件发布 (在现有服务中埋点)
- [ ] 订阅匹配 + 消息/webhook 分发
- [ ] Agent 订阅 API

**产出：** Agent 可以订阅 "有 code_review 任务创建时通知我"。

### Phase 4: Workflow Engine — 🔮 v0.8.0+（不在 v1.7.2 范围内）

> **明确不做。** 这本质是状态机 + task graph 问题，需要完整的 DAG 引擎设计。等 Phase 0-3 验证任务模式后，作为 Agent Economy (v0.8.0+) 的一部分推进。

- [ ] `im_workflows` + `im_workflow_steps` 表
- [ ] DAG 解析 + 依赖追踪
- [ ] Step 模板变量替换
- [ ] 并行分支 + 条件跳过
- [ ] 可视化 (前端 DAG 编辑器)

**产出：** 用户或 agent 可以定义多步骤工作流，Cloud 自动编排多个 agent 协作。

---

## 五、与现有系统的关系

### 5.1 与 IM 消息系统的关系

Task 不是独立系统——它**复用 IM 消息作为传输层**。

```
创建任务 → im_tasks 表写入
         → 给 assignee 发送 IM 消息 (type: "task", metadata: { taskId })
         → Agent 通过 WS/SSE/webhook/sync 收到
         → Agent 处理后 POST /tasks/:id/complete
         → 给 creator 发送结果消息
```

好处：
- 不需要额外的推送通道
- 消息历史自然包含任务上下文
- 离线 agent 通过现有 sync 机制获取任务
- Credits 扣费复用现有 `deductCredits()`

### 5.2 与 Agent Economy 的关系

这套方案取代了 `AGENT_REQUIREMENTS_PRISMER.md` 中 v0.8.0 的任务市场设计。

| 原设计 | 本方案 | 区别 |
|--------|--------|------|
| 竞标模式 (BIDDING → ASSIGNED) | 直接分配 + 主动领取 | 去掉竞标，简化为 push/pull |
| 服务目录 | Agent capability 声明 + discover | 复用现有 agent 注册 |
| Escrow (托管支付) | Task budget + 完成后结算 | 简化为"先扣后退" |
| 信誉系统 | Phase 4+ | 暂不实现 |

### 5.3 与 OpenClaw Channel Plugin 的关系

Plugin 是**执行侧的 SDK**。Cloud Task Store 是**调度侧的基础设施**。

```
                    Cloud (调度)                 Agent (执行)
                    ─────────                    ─────────
                    im_tasks 表                  OpenClaw channel plugin
                    Scheduler                    prismer_discover tool
                    Event Bus                    prismer_send tool
                    Task API                     gateway (WS 收消息)
                         │                            │
                         └──── IM 消息 ────────────────┘
```

Plugin 侧需要增加的：
- 识别 `type: "task"` 消息，交给 AI 管线处理
- 新 tool: `prismer_task_complete` (汇报结果)
- 新 tool: `prismer_task_create` (创建/委托任务)

---

## 六、关键决策点

### Q1: 调度器在 IM Server 进程内还是独立进程？

**建议：IM Server 进程内**。理由：
- 当前单进程架构 (Next.js + Hono in-process)
- 调度器是轻量循环 (10s/次, SQL 查询)
- 不需要独立部署/运维
- `FOR UPDATE SKIP LOCKED` 解决多 Pod 并发

未来如果任务量巨大 (10万+/天)，再考虑拆分为独立 worker。

### Q2: Agent 离线时任务怎么办？

三种策略：
1. **等待** — 任务 pending 直到 agent 上线 (适合非紧急)
2. **超时重分配** — `timeout_ms` 后自动转给其他 agent (适合有时效性的)
3. **Webhook 唤醒** — 如果 agent 配了 webhook endpoint，POST 过去唤醒 (适合 serverless agent)

建议默认策略 2，超时后自动重新 match。

### Q3: 定时任务的时区问题？

- 存储统一用 UTC
- API 接受 `timezone` 参数，Cloud 侧转换
- Cron 表达式基于 UTC 执行

### Q4: 和 v0.8.0 Agent Economy 的先后关系？

本方案是 Economy 的**前置基础设施**。路线：

```
Task Store (本方案) → 验证任务模式 → Service Catalog → Escrow → 信誉系统
```

先跑通 "创建任务 → 分配 → 执行 → 完成" 闭环，再加经济层。

---

## 七、v1.7.2 范围明确

**v1.7.2 三大支柱：Agent Orchestration (Phase 0-3) + E2E Encryption Hardening (Layer 1-2) + Memory Layer (Phase M1-M3)。** 全 SDK 生态更新。

### 支柱一：Agent Orchestration（本文档）

| 做 (v1.7.2) | 不做 (v0.8.0+ 或更远) |
|-------------|---------------------|
| Agent discover/send tools | Multi-Agent Workflow DAG (状态机 + task graph) |
| Cloud Task Store (im_tasks) | 竞标系统 |
| Scheduler (cron + one-shot, OpenClaw cron 云端化) | 信誉系统 |
| Event Subscriptions (OpenClaw hooks 云端化) | Web3 / 链上结算 |
| SDK Task API client methods | Agent 热迁移 |
| MCP create_task tool | Workflow 可视化编辑器 |

### 支柱二：E2E Encryption Hardening（[设计文档](./E2E-ENCRYPTION-HARDENING.md)）

| 做 (v1.7.2) | 不做 (v1.8.0+) |
|-------------|----------------|
| Ed25519 身份密钥生成/存储 | Trust tiers (2-4) 分级实施 |
| 消息签名 (Ed25519 + sequence number) | 反垃圾/反滥用 (rate limiting, spam detection) |
| Server-vouched identity | 群组密钥轮换 |
| SDK 签名验证 API | Content-hash chain (prevHash) |

### 支柱三：Memory Layer（[设计文档](./MEMORY-LAYER.md)）

| 做 (v1.7.2) | 不做 (v0.5.0+) |
|-------------|----------------|
| Working Memory (compaction + prune) | 向量搜索 / embedding |
| Episodic Memory (MEMORY.md + topic files) | 自动记忆衰减 |
| Memory tools (write/read for OpenClaw + MCP) | Knowledge Base RAG |
| Memory flush (会话 → 持久化沉淀) | 多 agent 共享记忆空间 |

---

*Last updated: 2026-03-09*
