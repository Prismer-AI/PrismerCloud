# SDK 设计评审 — 从薄层到 Agent Runtime

> **Version:** 3.0
> **Date:** 2026-03-24
> **Status:** L0-L5 全部 4 SDK 完成，L6 设计中

---

## 1. 当前状态

全部 4 SDK 已有完整的 EvolutionRuntime 组装层（L0-L5）。

SDK 各语言的机制层覆盖：

| 模块                 | TS              | Python                 | Go                     | Rust                  | 功能                               |
| -------------------- | --------------- | ---------------------- | ---------------------- | --------------------- | ---------------------------------- |
| **REST Client**      | ✅              | ✅                     | ✅                     | ✅                    | HTTP 调用薄包装（~30 个方法）      |
| **EvolutionCache**   | ✅ (155行)      | ✅ evolution_cache.py  | ✅ evolution_cache.go  | ✅ evolution_cache.rs | 本地 gene 缓存 + Thompson Sampling |
| **SignalEnrichment** | ✅ (106行)      | ✅ signal_rules.py     | ✅ signal_rules.go     | ✅ signal_rules.rs    | 客户端 signal 提取（16 patterns）  |
| **EvolutionOutbox**  | 🔄 Runtime 内联 | ✅ evolution_outbox.py | ✅ evolution_outbox.go | 🔄 Runtime 内联       | fire-and-forget 写入               |
| **EvolutionRuntime** | ✅ (350行)      | ✅ sync+async          | ✅ goroutine           | ✅ manual drive       | suggest()+learned() 编排层         |
| **Session Tracking** | ✅              | ✅ sync+async          | ✅                     | ✅                    | EvolutionSession + SessionMetrics  |
| **OfflineManager**   | ✅ (1020行)     | ✅ offline.py          | ✅ offline.go          | ✅ offline.rs         | 离线队列 + 同步引擎                |
| **Encryption**       | ✅ (266行)      | ✅ encryption.py       | ✅ encryption.go       | ✅ encryption.rs      | E2E 加密管道                       |
| **Realtime**         | ✅ WS+SSE       | ✅ WS                  | ✅ WS                  | ✅ WS                 | 实时连接                           |

TS SDK 两种使用方式对比：

```typescript
// 方式 A: 底层 API (7 步，仍可用但不推荐)
const sdk = new PrismerClient({ apiKey: '...' });
const signals = extractSignals({ error: errorMsg });
const advice = await sdk.im.evolution.analyze({ signals });
if (advice.data?.action === 'apply_gene') { /* 自己解析 strategy */ }
await sdk.im.evolution.record({ gene_id: ..., signals: ..., outcome: ... });

// 方式 B: EvolutionRuntime (2 步，推荐)
const runtime = new EvolutionRuntime(sdk.im.evolution);
await runtime.start(); // bootstrap cache + sync

const fix = await runtime.suggest('ETIMEDOUT: connection timed out');
// fix.strategy = ["Increase timeout to 30s", "Retry with backoff", ...]
// ... agent 执行 strategy ...
runtime.learned('ETIMEDOUT', 'success', 'Fixed by increasing timeout');
// fire-and-forget, 异步上传, 断网自动重传
```

---

## 2. 用户真正需要什么

从第一性原理出发，agent 开发者的需求是：

### 需求 A：我遇到错误了，帮我找解决方案

```typescript
// 理想API
const fix = await evolution.suggest(error, context);
// 返回：具体的 strategy 步骤，可以直接执行
// 内部自动做了：signal 提取 → analyze → gene 选择 → strategy 返回
```

### 需求 B：我解决了问题，记录一下

```typescript
// 理想API
evolution.learned(error, fix, outcome);
// 内部自动做了：signal 提取 → 匹配 gene → record → outbox 异步上传
// 不阻塞、不丢数据、断网后自动重传
```

### 需求 C：让进化自动发生，别让我操心

```typescript
// 理想API
const agent = sdk.createAgent({
  evolution: true, // 开启就完了
});
agent.onError(async (error, ctx) => {
  // SDK 自动 suggest + 注入 strategy 到 ctx
  // 执行完自动 record
});
```

### 需求 D：离线也能用

```typescript
// 理想API
const sdk = new PrismerClient({
  evolution: { offline: true },
});
// 断网时：本地 gene cache 做 selection，outbox 存 record
// 联网时：自动同步
```

---

## 3. 缺失的抽象

### 3.1 EvolutionRuntime — 统一编排层 ✅ (全部 4 SDK 已实现)

实际实现（TS ~350 行，Py ~550 行含 sync+async，Go ~470 行，Rust ~500 行）：

```typescript
class EvolutionRuntime {
  private cache: EvolutionCache; // 本地 gene 选择 (Thompson Sampling)
  private client: EvolutionClient; // REST API
  private outbox: OutboxEntry[] = []; // 内联异步写入队列
  private _sessions: EvolutionSession[] = []; // L5 session tracking

  constructor(client: EvolutionClient, config?: EvolutionRuntimeConfig) {
    this.cache = new EvolutionCache();
  }

  async start(): Promise<void> {
    // 拉取 sync snapshot 填充 cache，启动定期同步和 flush
    const snapshot = await this.client.getSyncSnapshot();
    this.cache.loadSnapshot(snapshot);
  }

  // 需求 A: 一行代码获取建议
  async suggest(error: string | Error): Promise<Suggestion> {
    const signals = extractSignals({ error }); // 函数调用，非类实例
    // 优先本地 cache（<1ms）
    const local = this.cache.selectGene(signals);
    if (local.action === 'apply_gene' && local.confidence > 0.3) {
      this.startSession(local); // L5: 追踪 session
      return local;
    }
    // fallback 到服务端
    const server = await this.client.analyze({ signals });
    this.startSession(server);
    return server;
  }

  // 需求 B: 一行代码记录结果（不阻塞）
  learned(error: string | Error, outcome: 'success' | 'failed', summary: string): void {
    const signals = extractSignals({ error });
    this.completeSession(outcome); // L5: 关联 session
    this.outbox.push({ gene_id: this.lastSuggestedGeneId, signals, outcome, summary });
  }

  // L5: session metrics
  getMetrics(): SessionMetrics {
    /* GUR, success rates, cache hit rate, avg duration */
  }
  get sessions(): readonly EvolutionSession[] {
    return this._sessions;
  }
}
```

### 3.2 EvolutionSession — 追踪单次任务 ✅ (全部 4 SDK 已实现)

内嵌在 EvolutionRuntime 中，自动在 `suggest()` 时开启、`learned()` 时关闭：

```typescript
// 自动追踪，用户无需手动操作
interface EvolutionSession {
  id: string;
  suggestedAt: number;
  suggestedGeneId?: string; // suggest() 推荐的 gene
  usedGeneId?: string; // learned() 实际用的 gene
  adopted: boolean; // usedGeneId === suggestedGeneId
  outcome?: 'success' | 'failed';
  durationMs?: number; // suggest → learned 耗时
  confidence: number;
  fromCache: boolean;
}

interface SessionMetrics {
  totalSuggestions: number;
  suggestionsWithGene: number;
  totalLearned: number;
  adoptedCount: number;
  geneUtilizationRate: number; // adopted / with_gene
  avgDurationMs: number;
  adoptedSuccessRate: number; // 用了推荐 gene 的成功率
  nonAdoptedSuccessRate: number; // 没用推荐 gene 的成功率
  cacheHitRate: number; // 本地 cache 命中率
}
```

### 3.3 Agent Middleware / Hook

对于框架级集成（Claude Code MCP、OpenCode SDK、OpenClaw），SDK 应该提供 middleware：

```typescript
// 框架无关的 lifecycle hook
interface EvolutionHook {
  beforeTask?(task: TaskContext): Promise<void>; // 自动 suggest
  afterTask?(task: TaskContext, result: TaskResult): Promise<void>; // 自动 record
  onError?(error: Error, task: TaskContext): Promise<Suggestion | null>; // 错误时自动推荐
}

// 使用
const evolution = new EvolutionRuntime(client);
const hook = evolution.createHook();
// 注入到 agent 框架
agent.use(hook);
```

---

## 4. SDK 覆盖度矩阵

| 抽象层                       | TS                                     | Py              | Go             | Rust                 | 状态                    |
| ---------------------------- | -------------------------------------- | --------------- | -------------- | -------------------- | ----------------------- |
| **L0: REST Client**          | ✅ 104 methods                         | ✅              | ✅             | ✅                   | 完整                    |
| **L1: Signal Enrichment**    | ✅                                     | ✅              | ✅             | ✅ (signal_rules.rs) | 全部完成                |
| **L2: Evolution Cache**      | ✅                                     | ✅              | ✅             | ✅                   | 全部完成                |
| **L3: Outbox (async write)** | 🔄 Runtime 内联                        | ✅              | ✅             | 🔄 Runtime 内联      | 全部完成 (TS/Rust 内联) |
| **L4: EvolutionRuntime**     | ✅                                     | ✅ (sync+async) | ✅ (goroutine) | ✅ (manual drive)    | 全部完成                |
| **L5: Session tracking**     | ✅ (EvolutionSession + SessionMetrics) | ✅ (sync+async) | ✅ (goroutine) | ✅ (manual drive)    | 全部完成                |
| **L6: Middleware/Hook**      | ❌                                     | ❌              | ❌             | ❌                   | 设计中                  |

---

## 5. 改进方案与执行状态

### P0: ✅ 已完成

```
EvolutionRuntime (全部 4 SDK):
  ✅ 组合 EvolutionCache + extractSignals + 内联 outbox → suggest() / learned()
  ✅ bootstrap: start() 自动拉 sync snapshot 填充 cache
  ✅ 定期同步: syncInterval 增量 pull (TS/Py async 自动, Go goroutine, Rust 手动)
  ✅ outbox: fire-and-forget + flush + failed re-enqueue
  ✅ L5 Session tracking: EvolutionSession + SessionMetrics + getMetrics()
  ✅ 导出: 各 SDK 主入口均导出 EvolutionRuntime
  ✅ 向后兼容: EvolutionClient 不变，Runtime 是可选叠加层
  文件: TS ~350行, Py ~550行 (sync+async), Go ~470行, Rust ~500行
```

### P1: ✅ 已完成

```
✅ EvolutionRuntime for Python + Go + Rust (移植 TS 实现)
✅ EvolutionCache for Python + Go + Rust (Thompson Sampling 本地选择)
✅ SignalEnrichment for Rust (signal_rules.rs)
✅ Session tracking (EvolutionSession + SessionMetrics + getMetrics()) — 全部 4 SDK
```

### P2: 根据 benchmark 结果决定

```
1. Middleware/Hook 系统 (TS → 框架无关 lifecycle 注入)
2. LLM-assisted signal enrichment (注入模式)
3. Plugin 使用 EvolutionRuntime 替代裸 API
```

---

## 6. 回归测试要求

### 6.1 现有功能不 break

```
所有现有测试必须通过:
  - EvolutionClient 的 30+ 方法: 类型签名不变、默认行为不变
  - OfflineManager: outbox 队列、sync 引擎
  - Realtime: WS/SSE 连接
  - Encryption: E2E 管道
```

### 6.2 新增 EvolutionRuntime 测试

```
脚本: sdk/tests/evolution-runtime.test.ts

1. suggest() 无网络: 本地 cache 返回结果 (<1ms)
2. suggest() 有网络: 网络优先，cache 做 fallback
3. learned() 不阻塞: 调用后立即返回，outbox 异步处理
4. learned() 离线: 断网时存入 outbox，联网后自动上传
5. bootstrap(): 初始化时拉取 snapshot 填充 cache
6. sync(): 定期同步增量数据
7. session tracking: suggest → complete 关联正确
8. 向后兼容: 不用 Runtime 也能正常用 EvolutionClient
```

### 6.3 各 SDK 一致性检查

```
脚本: sdk/tests/sdk-parity-check.ts

对比 4 个 SDK 的方法覆盖度:
  - 列出每个 SDK 的 public method
  - 标出差异
  - 允许的差异: 语言特性导致的（如 Rust 没有 async middleware）
  - 不允许的差异: 同一功能在 A 语言有但 B 没有
```

---

## 7. 与 benchmark 验证计划的关系

VERIFICATION-PLAN.md 的 A/B 实验依赖 SDK 的机制层：

| 实验需求          | SDK 支撑                             | TS  | Py  | Go  | Rust |
| ----------------- | ------------------------------------ | --- | --- | --- | ---- |
| 自动调 analyze    | EvolutionRuntime.suggest()           | ✅  | ✅  | ✅  | ✅   |
| 自动调 record     | EvolutionRuntime.learned() + Outbox  | ✅  | ✅  | ✅  | ✅   |
| 追踪 gene 采纳率  | SessionMetrics.gene_utilization_rate | ✅  | ✅  | ✅  | ✅   |
| 离线 A/B 对照     | Runtime OFF = 不初始化 Runtime       | ✅  | ✅  | ✅  | ✅   |
| 测量 suggest 延迟 | SessionMetrics.avg_duration_ms       | ✅  | ✅  | ✅  | ✅   |

全部 4 SDK 均可支撑多语言 benchmark 实验。

---

## 8. Plugin 设计评审

三个 plugin 的 evolution 集成已完成全闭环（suggest + report + record）。以下是改进前后对比：

### 8.1 改进前快照（存档）

|                         | Claude Code Plugin                                                 | OpenCode Plugin                                                  | OpenClaw Channel                                           |
| ----------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| **架构**                | PostToolUse hook + MCP (.mcp.json) + 3 Skills                      | OpenCode event hooks (session.error, tool.execute.after)         | OpenClaw ChannelPlugin (inbound/outbound/directory/tools)  |
| **文件数**              | 14 文件 (731 行)                                                   | 13 文件 (1161 行)                                                | 15 文件 (1617 行)                                          |
| **evolution 入口**      | `post-bash-report.mjs`: Bash 输出检测错误 → POST /evolution/report | `index.ts`: session.error + tool.execute.after → client.report() | `tools.ts`: prismer_evolve_analyze/record 作为 agent tools |
| **被动 report**         | ✅ 自动检测 Bash 错误上报                                          | ✅ 自动检测 session/tool 错误上报                                | ✅ 有 prismer_evolve_report tool                           |
| **主动 suggest**        | ❌                                                                 | ❌                                                               | ⚠️ analyze tool 存在但 agent 要自主调                      |
| **自动 learned**        | ❌                                                                 | ❌                                                               | ⚠️ record tool 存在但 agent 要自主调                       |
| **用 EvolutionRuntime** | ❌                                                                 | ❌                                                               | ❌                                                         |
| **用 EvolutionCache**   | ❌                                                                 | ❌                                                               | ❌                                                         |
| **用 SignalEnrichment** | ✅ 内联 regex (post-bash-report)                                   | ✅ EvolutionClient 内部                                          | ❌ 直接传 raw signal                                       |

### 8.2 改进前的核心问题（已解决）

改进前，三个 plugin 都只做了进化闭环的后半段（report/record），没有做前半段（suggest/recommend）：

```
改进前:
错误发生 → [suggest: ❌ 缺失] → 执行 → [learned: ⚠️ 部分] → 知识积累

改进后 (§8.4):
错误发生 → [suggest: ✅ 自动推荐] → 执行 → [learned: ✅ 自动记录] → 知识积累
```

### 8.3 改进方案（已全部实施）

**Claude Code Plugin:**

当前 hook 只在 PostToolUse 触发。需要加 PreToolUse hook——在 Bash 执行前检查 evolution 推荐：

```json
// hooks.json 改进
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/pre-bash-suggest.mjs\""
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/post-bash-report.mjs\""
          }
        ]
      }
    ]
  }
}
```

`pre-bash-suggest.mjs`：读取即将执行的命令 → 提取 signal → 调 evolve_analyze → 如果有高 confidence 推荐，注入到 hook 输出（Claude Code 会把 hook 输出作为额外上下文）。

**OpenCode Plugin:**

当前 `session.error` 和 `tool.execute.after` 只 report。增加：

- `tool.execute.before`: 调 evolution.suggest() → 注入推荐到 tool context
- 使用 EvolutionRuntime 代替裸 EvolutionClient（自动 cache + outbox）

**OpenClaw Channel:**

当前 tools 是被动等 agent 调用。增加：

- 在 `inbound.ts` 收到消息时自动检测错误 signal → 如果有推荐，附带在回复中
- webhook payload 中自动注入 evolution 建议

### 8.4 改进执行状态

| Plugin          | 改进                                | 状态      | 文件                                                     |
| --------------- | ----------------------------------- | --------- | -------------------------------------------------------- |
| **Claude Code** | PreToolUse hook: 执行前 suggest     | ✅ 已实现 | `scripts/pre-bash-suggest.mjs` + `hooks/hooks.json` 更新 |
| **OpenCode**    | tool.execute.before: 执行前 suggest | ✅ 已实现 | `src/index.ts` 新增 before hook                          |
| **OpenClaw**    | inbound 消息自动注入 evolution 建议 | ✅ 已实现 | `src/inbound.ts` handleInboundMessage 增强               |

**改进后的进化闭环：**

```
错误发生 → [suggest: 推荐已知 fix] → 执行 → [learned: 记录结果] → 知识积累
             ✅ PreToolUse hook           ✅ PostToolUse hook
             ✅ tool.execute.before        ✅ tool.execute.after / session.error
             ✅ inbound message hint       ✅ prismer_evolve_report tool
```

### 8.5 Plugin 回归测试

详见 [`SDK-REGRESSION.md`](./SDK-REGRESSION.md) Section 7 (14 个测试项)。

---

## 9. 不应该做什么

| 不做                       | 原因                                                       |
| -------------------------- | ---------------------------------------------------------- |
| SDK 内嵌 LLM 调用          | LLM 是 agent 的事，SDK 不应依赖特定 LLM                    |
| SDK 自动执行 strategy      | 执行是 agent 的事，SDK 只提供 strategy 内容                |
| SDK 管理 agent 生命周期    | SDK 是工具库，不是 agent 框架                              |
| 把所有服务端能力复制到 SDK | gene selection 的核心逻辑在服务端，SDK 只做 cache fallback |
| 自动创建 gene              | gene 创建需要人类判断，SDK 不应自动化                      |

**SDK 的边界：提供数据 + 异步 I/O + 本地缓存。不做决策。**

---

## 10. 实际评估结果 (2026-03-23, cloud.prismer.dev)

### 10.1 测试执行

```
脚本: scripts/sdk-evaluation.ts
目标: cloud.prismer.dev (v1.7.2)

第一轮 (改进前):      77/79 passed, 2 failed
第二轮 (TS Runtime):  86/86 passed, 0 failed
第三轮 (含 plugin):   113/113 passed, 0 failed
第四轮 (全 SDK L5):   181/181 passed, 0 failed  ← 2026-03-24
  新增覆盖: L1-L5 全部 4 SDK 机制层 + Session tracking + Exports
```

### 10.2 L1 方法覆盖度: ✅ 全部对齐

4 个 SDK 的 P0+P1 方法全部存在 (43/43 检查通过):

- TS: 12/12 ✅ (submitReport, getReportStatus, getAchievements, getSyncSnapshot, sync, Security 5个, listScopes, exportAsSkill)
- Python: 12/12 ✅
- Go: 12/12 ✅
- Rust: 7/7 ✅ (Security 方法在 im.rs 中)

### 10.3 L2 端到端功能: ✅ 全部通过

19 个 API 端点测试全部通过，包括：

- Evolution 核心 (analyze/genes/edges/capsules/report) ✅
- Scope 过滤 (scopes/genes?scope/analyze?scope) ✅
- 异步报告 (achievements/sync/snapshot) ✅
- Rate limit headers (x-ratelimit-limit=2) ✅
- Security 端点 (403 for non-participant) ✅
- Admin 端点 (403 for non-admin) ✅
- Scope 验证 (400 for invalid scope) ✅

### 10.4 L3 机制层 (第一轮快照 — 改进前)

| 机制             | TS               | Py  | Go  | Rust | 接入主客户端？ |
| ---------------- | ---------------- | --- | --- | ---- | -------------- |
| EvolutionCache   | ✅ 存在 (155行)  | ❌  | ❌  | ❌   | ❌ 未接入      |
| SignalEnrichment | ✅ 存在 (106行)  | ✅  | ✅  | ❌   | ❌ 未接入      |
| EvolutionOutbox  | ⚠️ 在 offline.ts | ✅  | ✅  | ❌   | ❌ 未接入      |

**具体发现:**

- EvolutionCache 缺少 `select()` 和 `loadDelta()` 方法 (2 个 FAIL)
  - 有 `loadSnapshot()` 和 Thompson Sampling，但核心的选择方法名不是 `select`
- 104 个 REST 方法中没有任何一个组合多个 API 调用
- MCP evolve_analyze 是唯一内置了 signal enrichment 的入口

### 10.5 L4 抽象评估 (第一轮快照 — 改进前)

**量化结论:**

- SDK 有 104 个 REST wrapper 方法 (L0 层)
- 0 个方法组合多个 API 调用
- EvolutionClient 不导入 EvolutionCache (零集成)
- EvolutionClient 不导入 SignalEnrichment (零集成)
- EvolutionRuntime 不存在

**用户体验影响:**

```
当前: 7 步手工流程
  1. 手动提取 signal → 2. 调 analyze → 3. 判断是否用推荐
  → 4. 解析 strategy → 5. 自己执行 → 6. 调 record → 7. 处理失败重试

目标: 2 步
  1. runtime.suggest(error) → 2. runtime.learned(outcome)
```

### 10.6 补足结果 (2026-03-23 第二轮)

**已修复:**

1. ✅ EvolutionRuntime 实现 (TS) — `sdk/typescript/src/evolution-runtime.ts` (~230 行)
   - `suggest(error, context?)` — 本地 cache (<1ms) → 服务端 fallback
   - `learned(error, outcome, summary)` — fire-and-forget outbox
   - `start()` / `stop()` — bootstrap + periodic sync
   - 内部组合 EvolutionCache + SignalEnrichment + outbox
2. ✅ EvolutionCache/SignalEnrichment/EvolutionRuntime 从 index.ts 导出
3. ✅ 类型补齐 — ExecutionContext, SignalEnrichmentConfig, GeneSelectionResult, EvolutionSyncSnapshot/Delta 加入 types.ts
4. ✅ DTS 类型错误修复 — IMRecordOutcomeOptions.strategy_used, llmExtract null check

**重新评估结果: 86/86 ✅ (0 failed)**

### 10.7 当前 SDK 层级状态

```
L0: REST Client (104 methods)       — ✅ 全部 4 SDK
L1: SignalEnrichment                 — ✅ 全部 4 SDK (16 error patterns)
L2: EvolutionCache                   — ✅ 全部 4 SDK (Thompson Sampling)
L3: EvolutionOutbox                  — ✅ Py/Go 独立 + TS/Rust Runtime 内联
L4: EvolutionRuntime                 — ✅ 全部 4 SDK
L5: Session tracking                 — ✅ 全部 4 SDK (EvolutionSession + SessionMetrics)
L6: Agent middleware/hook            — ⏳ 设计中
```

**用户体验变化:**

```
之前 (7 步):
  1. extractSignals → 2. analyze → 3. 判断 → 4. 解析 strategy
  → 5. 执行 → 6. record → 7. 处理失败

之后 (2 步, 全部 4 语言一致):
  # TypeScript
  const rt = new EvolutionRuntime(client.im.evolution);
  await rt.start();
  const fix = await rt.suggest('ETIMEDOUT');
  rt.learned('ETIMEDOUT', 'success', 'Fixed by increasing timeout');
  console.log(rt.getMetrics()); // GUR, success rates, cache hit rate

  # Python (sync)
  rt = EvolutionRuntime(client.im.evolution)
  rt.start()
  fix = rt.suggest("ETIMEDOUT")
  rt.learned("ETIMEDOUT", "success", "Fixed by increasing timeout")
  print(rt.get_metrics())

  # Go
  rt := prismer.NewEvolutionRuntime(client.Evolution(), nil)
  rt.Start(ctx)
  fix, _ := rt.Suggest(ctx, "ETIMEDOUT")
  rt.Learned("ETIMEDOUT", "success", "Fixed", "")
  fmt.Println(rt.GetMetrics())

  # Rust
  let mut rt = EvolutionRuntime::new(&client, None);
  rt.start().await?;
  let fix = rt.suggest("ETIMEDOUT").await?;
  rt.learned("ETIMEDOUT", "success", "Fixed", None);
  println!("{:?}", rt.get_metrics());
```

### 10.8 L5 Plugin 评估: ✅ 全部通过 (第三轮)

| Plugin          | 检查项                                                                                  | 通过     |
| --------------- | --------------------------------------------------------------------------------------- | -------- |
| **Claude Code** | PreToolUse hook + PostToolUse hook + pre-suggest + post-report + MCP + 3 Skills + scope | 12/12 ✅ |
| **OpenCode**    | before/after/error hooks + analyze/suggest + scope + achievements + sync                | 7/7 ✅   |
| **OpenClaw**    | inbound evolution + analyze/record/report tools + scope + hint injection                | 8/8 ✅   |
| **MCP Server**  | 23 tools registered                                                                     | 1/1 ✅   |

进化闭环覆盖（第三轮确认）:

```
                      Claude Code    OpenCode       OpenClaw
suggest (执行前推荐)   ✅ PreToolUse   ✅ before hook  ✅ inbound hint
report  (错误上报)     ✅ PostToolUse  ✅ error/after   ✅ report tool
record  (结果记录)     ✅ MCP tool     ✅ MCP tool      ✅ record tool
scope   (域隔离)       ✅ skill 文档   ✅ client 支持   ✅ tools 支持
```

### 10.9 已完成改进 (P0-P2)

| 优先级 | 改进                                   | 状态                                                |
| ------ | -------------------------------------- | --------------------------------------------------- |
| P0     | EvolutionRuntime (TS)                  | ✅ suggest() + learned() + start/stop               |
| P1     | EvolutionCache 移植到 Python/Go/Rust   | ✅ Thompson Sampling 全部一致                       |
| P1     | EvolutionRuntime 移植到 Python/Go/Rust | ✅ 全部完成                                         |
| P1     | SignalEnrichment 移植到 Rust           | ✅ signal_rules.rs (16 patterns)                    |
| P2     | Session tracking (全部 4 SDK)          | ✅ EvolutionSession + SessionMetrics + getMetrics() |
| P2     | Plugin suggest 闭环 (3 plugins)        | ✅ PreToolUse + before hook + inbound hint          |

### 10.10 未来改进 (P3)

| 改进                                    | 状态      | 备注                                    |
| --------------------------------------- | --------- | --------------------------------------- |
| Plugin 使用 EvolutionRuntime 替代裸 API | ⏳        | 当前 plugin 直接调 REST，可改用 Runtime |
| L6 Middleware/Hook 系统                 | ⏳ 设计中 | 框架无关 lifecycle 注入                 |
| LLM-assisted signal enrichment          | ⏳        | 注入模式，agent 自选 LLM                |
| Signal enrichment 准确率测试            | ⏳        | 需要生产数据验证 16 patterns 覆盖率     |

_Last updated: 2026-03-24 (v3.0 — 全部 6 处内部不一致修复，文档闭合)_
