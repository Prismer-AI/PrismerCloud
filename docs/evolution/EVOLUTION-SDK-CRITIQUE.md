# Evolution SDK 架构批判与重设计

> **Date:** 2026-03-20
> **Status:** 设计文档（未实施）
> **视角:** 站在 Karpathy（数据/推理效率）和 Jeff Dean（分布式系统可靠性）的角度审视
> **触发:** 全量回归 68/68 通过后的冷静反思 — "能跑通"不等于"架构正确"

---

## 1. 当前 SDK 的实际形态

```typescript
// 这就是今天 SDK 里 Evolution 的全部能力
class EvolutionClient {
  analyze(options)     → POST /evolution/analyze     // 同步 HTTP
  record(options)      → POST /evolution/record       // 同步 HTTP
  createGene(options)  → POST /evolution/genes        // 同步 HTTP
  distill(dryRun?)     → POST /evolution/distill      // 同步 HTTP
  getEdges(options?)   → GET  /evolution/edges        // 同步 HTTP
  getReport()          → GET  /evolution/report       // 同步 HTTP
  // ... 全部是 1:1 HTTP wrapper
}
```

**SDK 是一层没有自己状态的 HTTP 代理。** 所有计算（Thompson Sampling、tagCoverageScore、Pooled Prior）都在服务端。SDK 不缓存、不排队、不做本地决策。

---

## 2. 三个结构性问题

### 2.1 问题一：Gene 选择是同步网络调用

Agent 的执行循环：

```
observe(signal) → select(gene) → execute(strategy) → record(outcome)
                   ↑
                   这里是一次 HTTP 往返 (100-500ms)
```

**Gene 选择不能降级。** 消息可以本地排队（SDK 的 OfflineManager 已经做到了），但 Gene 选择必须立刻返回结果——Agent 需要知道该用什么策略。如果网络不可达，整个进化系统瘫痪。

而实际上：

- Gene 库变化频率：每小时个位数
- Edge 数据变化频率：每分钟级别
- Gene 选择频率：每秒级别（高峰期）

**用最慢的更新频率（HTTP 往返）去服务最高的查询频率，这是架构上的阻抗失配。**

### 2.2 问题二：Outcome 写入是同步阻塞

```typescript
// 当前：Agent 执行完毕后同步等待服务端确认
await evolution.record({ gene_id, signals, outcome: 'success', summary: '...' });
// 如果这里超时/失败，outcome 数据丢失
```

`recordOutcome()` 的信息是 α/β 增量更新。这是**可交换的累加量**——延迟到达 5 秒、5 分钟甚至 5 小时不影响 Thompson Sampling 的最终收敛。但当前实现把它做成了同步阻塞：

- Agent 的任务延迟直接加上了 record 的网络延迟
- 网络故障时 outcome 丢失（比延迟更严重——这是**学习数据的永久丢失**）
- 如果 Agent 并发执行多个任务，record 调用的串行化成为瓶颈

### 2.3 问题三：信号抽象完全缺失

**当前没有任何 SDK 侧的信号提取能力。**

服务端的 `extractSignals()` 接收结构化字段（`error`, `taskStatus`, `tags`）并生成 `SignalTag[]`。但这个过程应该发生在 Agent 侧——因为：

1. **Agent 有完整的执行上下文。** 服务端只看到 Agent 选择发送的字段。Agent 知道当前 stack trace、环境变量、上游依赖状态——这些信息在网络传输中丢失
2. **信号提取可以利用 Agent 自己的 LLM。** 一个运行在 Claude/GPT 上的 Agent 完全有能力从一段 error log 中提取结构化 SignalTag，比服务端的正则匹配（`normalizeError()`）精度高一个量级
3. **SDK 的类型定义还停在 v0.2.x。** `signals: string[]` 而非 `SignalTag[]`，`GeneCategory` 缺 `'diagnostic'`，`action` 缺 `'create_suggested'`

---

## 3. 更深层的问题：LLM 依赖在哪一层？

当前系统中依赖 LLM 的操作：

| 操作                                       | 在哪里执行                     | LLM 调用方                    | 频率                |
| ------------------------------------------ | ------------------------------ | ----------------------------- | ------------------- |
| Signal 提取（从 error log 提取结构化标签） | 服务端 `extractSignals()`      | **无 LLM**（正则+硬编码规则） | 每次 analyze        |
| Gene 蒸馏（从成功 capsules 合成新 Gene）   | 服务端 `triggerDistillation()` | 服务端 OpenAI 调用            | 每 Agent 每天 ≤3 次 |
| Gene 蒸馏 Critique                         | 服务端 `triggerDistillation()` | 服务端 OpenAI 调用            | 同上                |
| Gene strategy 执行                         | Agent 侧                       | Agent 自己的 LLM              | 每次任务            |

**观察：**

1. **信号提取没用 LLM，但最应该用。** 当前的 `normalizeError()` 是硬编码的 `if (lower.includes('timeout')) return 'timeout'`。这意味着 "Error: context deadline exceeded (net/http: request canceled)" 不会被归为 timeout——它会落入 fallback 的 50 字符截断。LLM 能在一次调用中把这个 error 映射为 `{type: "error:timeout", provider: "http", stage: "request", severity: "transient"}`

2. **蒸馏正确地放在服务端。** 蒸馏是低频、重计算、需要全局数据的操作。放在 Agent 侧没有意义——Agent 看不到其他 Agent 的 capsule

3. **缺失的层：Agent 侧的"进化中间件"。** 在 Agent framework（LangGraph、CrewAI、OpenClaw）和 Prismer Cloud 之间，应该有一层本地运行时——理解 Agent 的执行上下文，生成高质量 SignalTag，缓存 gene 库，异步上报 outcome

---

## 4. 重设计方向

### 4.1 三层架构（不是两层）

```
当前: Agent ─── SDK (HTTP thin wrapper) ─── Cloud

重设计:
                                              ┌──────────────────────────┐
                                              │  Prismer Cloud (Server)  │
                                              │                          │
                                              │  Pooled Prior 聚合       │
                                              │  Gene 蒸馏 (LLM)        │
                                              │  超图存储               │
                                              │  Cross-agent 知识共享    │
                                              │  A/B 实验控制           │
                                              └────────────┬─────────────┘
                                                           │ 异步同步
                                                           │ (增量拉/推)
                                                           │
                        ┌──────────────────────────────────┼──────────────────────────┐
                        │  SDK — Local Evolution Runtime                               │
                        │                                                              │
                        │  ┌─────────────┐  ┌───────────────┐  ┌───────────────────┐  │
                        │  │ Gene Cache   │  │ Edge Snapshot │  │ Outcome Outbox    │  │
                        │  │ (读优化)     │  │ (α/β 本地副本)│  │ (write-ahead log) │  │
                        │  └──────┬──────┘  └───────┬───────┘  └────────┬──────────┘  │
                        │         │                 │                    │              │
                        │         ▼                 ▼                    ▼              │
                        │  selectGene()       betaSample()        queueOutcome()       │
                        │  (本地计算)        (纯 CPU)           (本地持久化)            │
                        │                                                              │
                        │  ┌──────────────────────────────────────────────────────┐    │
                        │  │ Signal Enrichment Layer (可选 LLM)                   │    │
                        │  │                                                      │    │
                        │  │ • extractSignals(context) → SignalTag[]             │    │
                        │  │ • 可以调用 Agent 本地 LLM 做高精度信号提取           │    │
                        │  │ • 也可以用纯规则 fallback（当前 normalizeError）     │    │
                        │  └──────────────────────────────────────────────────────┘    │
                        │                                                              │
                        └──────────────────────────────────────────────────────────────┘
                                                           │
                                                           │ 同步接口
                                                           ▼
                        ┌──────────────────────────────────────────────────────────────┐
                        │  Agent (Claude / GPT / Local LLM)                            │
                        │  执行 Gene strategy → 产生 outcome                           │
                        └──────────────────────────────────────────────────────────────┘
```

### 4.2 Local Evolution Runtime 的 API 设计

```typescript
// ═══ 新 SDK 接口设计 ═══

interface PrismerEvolution {
  // ── 同步本地操作（不依赖网络） ──

  /**
   * 从本地 Gene Cache + Edge Snapshot 选择最佳 Gene。
   * 纯本地计算：tagCoverageScore + betaSample + 时间衰减。
   * 不需要网络。毫秒级返回。
   */
  selectGene(signals: SignalTag[]): SelectionResult;

  /**
   * 提取信号（可选 LLM 增强）。
   * 纯本地：用内置规则提取。
   * LLM 增强：调用 Agent 注入的 LLM 函数。
   */
  extractSignals(context: ExecutionContext): SignalTag[];

  // ── 异步后台操作（网络可选） ──

  /**
   * 记录 outcome 到本地 WAL（Write-Ahead Log）。
   * 立即返回。后台异步上传到 Cloud。
   * 即使网络完全不可达，数据也不会丢失。
   */
  recordOutcome(input: OutcomeInput): void;  // 注意：void，不是 Promise

  /**
   * 手动触发同步（通常不需要手动调用）。
   * 后台 sync 引擎默认每 30s 自动拉取/推送。
   */
  sync(): Promise<SyncResult>;

  // ── 生命周期 ──

  /**
   * 初始化：从 Cloud 拉取 Gene 库快照 + Edge 数据。
   * 首次初始化后，所有 selectGene 调用都是本地的。
   */
  initialize(): Promise<void>;

  /**
   * 关闭：flush 所有待上传的 outcome，断开同步。
   */
  close(): Promise<void>;

  // ── 事件 ──
  on(event: 'gene.updated', cb: (gene: Gene) => void): void;
  on(event: 'sync.complete', cb: (result: SyncResult) => void): void;
  on(event: 'outcome.flushed', cb: (count: number) => void): void;
}

// ── Signal Enrichment (可选 LLM 注入) ──

interface SignalEnrichmentConfig {
  /**
   * 纯规则模式（默认）：和当前 normalizeError 一样。
   * 不需要 LLM，零延迟，但精度有限。
   */
  mode: 'rules';
} | {
  /**
   * LLM 增强模式：Agent 注入自己的 LLM 函数。
   * SDK 调用它来做高精度信号提取。
   */
  mode: 'llm';
  /** Agent 提供的 LLM 调用函数 */
  llmExtract: (context: ExecutionContext) => Promise<SignalTag[]>;
  /** 超时 fallback 到 rules 模式（默认 3s） */
  timeoutMs?: number;
};
```

### 4.3 同步协议设计

```
═══ 初始化 ═══

SDK.initialize()
  → GET /evolution/sync/snapshot?since=0
  ← { genes: Gene[], edges: Edge[], globalPrior: PriorData, cursor: number }
  → 写入本地 Gene Cache + Edge Snapshot

═══ 增量同步（每 30s 或 outcome flush 后） ═══

SDK → Cloud:
  POST /evolution/sync/push
  { outcomes: [...queued outcomes], lastPullCursor: number }

Cloud → SDK:
  {
    updatedGenes: Gene[],       // 新增/变更的 gene
    updatedEdges: Edge[],       // 其他 agent 的 edge 更新（只发 globalPrior delta）
    newCursor: number,
    promotions: string[],       // canary → published 的 gene ID
    quarantines: string[],      // 被隔离的 gene ID
  }

═══ Edge 合并（CRDT-like） ═══

本地 edge: α_local = 5, β_local = 2
Cloud delta: Δα_global = +3, Δβ_global = +1

合并后: α_local = 5, β_local = 2  (本地不变)
全局先验: α_global = old + 3, β_global = old + 1  (增量加)

这是天然可交换的——不需要锁，不需要版本冲突处理。
```

### 4.4 LLM 信号提取 vs 规则提取

```typescript
// ═══ 规则模式（当前实现，迁移到 SDK 侧） ═══

function rulesExtract(ctx: ExecutionContext): SignalTag[] {
  const tags: SignalTag[] = [];
  if (ctx.error) {
    const type = normalizeError(ctx.error); // 正则匹配
    tags.push({ type: `error:${type}` });
  }
  if (ctx.taskStatus === 'failed') tags.push({ type: 'task.failed' });
  return tags;
}

// ═══ LLM 增强模式（新增，Agent 注入） ═══

// Agent 在初始化时注入自己的 LLM 函数：
const evolution = prismer.evolution({
  signalEnrichment: {
    mode: 'llm',
    llmExtract: async (ctx) => {
      // Agent 用自己的 LLM 做高精度提取
      const response = await myLLM.chat([
        {
          role: 'system',
          content: 'Extract structured signal tags from this execution context...',
        },
        {
          role: 'user',
          content: JSON.stringify(ctx),
        },
      ]);
      return JSON.parse(response.content); // → SignalTag[]
    },
    timeoutMs: 3000, // 超时 fallback 到 rules
  },
});

// 使用时：
const signals = evolution.extractSignals({
  error: 'Error: context deadline exceeded (net/http: request canceled)',
  stack: '...',
  environment: { provider: 'openai', region: 'us-east-1' },
});
// LLM 模式返回:
// [{ type: "error:timeout", provider: "openai", stage: "http_request", severity: "transient" }]
//
// 规则模式只会返回:
// [{ type: "error:timeout" }]
```

---

## 5. 为什么当前架构能"跑通"但是脆弱的

| 场景                             | 当前行为                            | 正确行为                                 |
| -------------------------------- | ----------------------------------- | ---------------------------------------- |
| Cloud 服务短暂不可达（10s）      | Agent 无法选 gene，任务卡住         | 从本地缓存选 gene，继续执行              |
| Cloud 服务长时间宕机（1h）       | 进化系统完全瘫痪，所有 outcome 丢失 | 本地 WAL 积累 outcomes，恢复后批量 flush |
| 网络延迟 spike（2s）             | analyze + record 每次加 4s 延迟     | selectGene 本地 <1ms，record 立即返回    |
| 100 个 Agent 同时 recordOutcome  | 100 个并发写 + DB 锁竞争            | 100 个本地写 → 异步 batch push           |
| Agent 在受限环境（CI/CD runner） | 无法连 Cloud → 无法进化             | 本地缓存有上次同步的 gene 库             |

---

## 6. 不做的事情

- **不在 SDK 侧做 Pooled Prior 聚合。** 全局先验需要所有 Agent 的数据，必须在 Cloud 端。SDK 只拉取聚合结果
- **不在 SDK 侧存 capsule 历史。** Capsule 是 append-only 审计流，只需要排队上传，不需要本地查询
- **不在 SDK 侧做蒸馏。** 蒸馏需要跨 Agent 的 capsule + LLM 调用，属于 Cloud 端的离线任务
- **不强制 LLM 信号提取。** 规则模式是零依赖 fallback，LLM 模式是可选增强
- **不做复杂的冲突解决。** α/β 是加法的，merge = 相加。Gene 的 create/delete/publish 走 Cloud 端的 CRUD 接口

---

## 7. 实施优先级

| 优先级 | 改动                                                           | 收益                  | 工作量 | 破坏性         |
| ------ | -------------------------------------------------------------- | --------------------- | ------ | -------------- |
| **P0** | SDK 类型对齐 v0.3.0（SignalTag, diagnostic, create_suggested） | 类型安全              | 2h     | 无             |
| **P0** | `recordOutcome()` 本地 WAL + 异步 flush                        | 消除写延迟 + 防丢数据 | 2d     | API 兼容       |
| **P1** | Gene 库本地缓存 + 增量同步                                     | 离线可选 gene         | 3d     | 需新 sync 端点 |
| **P1** | Edge 快照 + `selectGene()` 本地计算                            | 完全离线进化          | 3d     | 算法迁移       |
| **P1** | Signal Enrichment Layer（rules 模式）                          | SDK 侧信号提取        | 1d     | 无             |
| **P2** | Signal Enrichment Layer（LLM 注入模式）                        | 高精度信号            | 2d     | 无             |
| **P2** | 同步协议（push/pull + cursor）                                 | 完整 local-first      | 3d     | 需新 API       |
| **P3** | 多 SDK 统一（TS/Py/Go/Rust 共享协议）                          | 一致性                | 5d     | 跨语言         |

---

## 8. 第一性原理总结

**进化是一个学习过程。学习的核心瓶颈应该是数据质量和样本量，不应该是网络延迟。**

当前 SDK 把"推理"（gene selection）和"训练"（outcome recording）都放在远端——等价于把一个 embedding lookup 和一个梯度更新都做成了 RPC 调用。这在原型阶段可以接受，但如果 Prismer 的愿景是成为 Agent 的"进化基础设施"，SDK 必须承担更多本地智能：

1. **推理在本地（gene selection）** — 就像模型推理在设备端
2. **训练数据异步上报（outcome recording）** — 就像 federated learning 的梯度上传
3. **全局聚合在云端（pooled prior）** — 就像参数服务器
4. **信号提取利用本地 LLM（enrichment）** — 就像 feature engineering 在数据源完成

**这不是过度设计——这是分布式学习系统的标准架构。** 当前的全同步设计在 10 个 Agent 时没问题，在 1000 个 Agent 时会成为瓶颈，在 10000 个 Agent 时会崩溃。
