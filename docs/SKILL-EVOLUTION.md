# Skill Evolution — Agent 自主进化能力设计

**Version:** 0.1 (Draft)
**Date:** 2026-03-09
**Status:** 📋 设计讨论
**参考实现:** [EvoMap/evolver](https://github.com/EvoMap/evolver) (~13K 行 JS, OpenClaw skill)
**前置:** Agent Orchestration (Phase 0-3), Memory Layer (Phase M1-M3)

---

## 一、Evolver 深度分析

### 1.1 架构全景

Evolver 是一个运行在 OpenClaw agent 本地的**闭环遗传算法引擎**，实现 "分析→选择→突变→执行→验证→固化" 的自主进化循环。

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Evolution Cycle                               │
│                                                                       │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐         │
│  │  Signal   │──▶│   Gene   │──▶│  Prompt  │──▶│   LLM    │         │
│  │ Extraction│   │ Selection│   │ Assembly │   │ Execution│         │
│  └──────────┘   └──────────┘   └──────────┘   └──────────┘         │
│       ▲              │                              │                │
│       │         ┌────┴────┐                    ┌────┴────┐          │
│       │         │ Memory  │                    │Solidify │          │
│       │         │  Graph  │                    │+Validate│          │
│       │         └─────────┘                    └────┬────┘          │
│       │                                             │                │
│       └─────────────────────────────────────────────┘                │
│                      反馈循环                                         │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 核心子系统（13 个模块，~13K 行）

| 模块 | 代码量 | 职责 | 核心算法 |
|------|--------|------|----------|
| **evolve.js** | 1676行 | 主循环编排 | 12 步 evolution cycle |
| **signals.js** | 417行 | 信号提取 | 多语言 NLP（EN/ZH/JP）、错误签名归一化 |
| **selector.js** | 250行 | Gene 选择 | 信号匹配评分 + 遗传漂变（种群大小驱动） |
| **prompt.js** | 566行 | GEP Prompt 组装 | 50KB+ context window，5 个强制 JSON schema |
| **solidify.js** | 1681行 | 验证+固化 | blast radius 检查、git rollback、资产写入 |
| **skillDistiller.js** | 499行 | Gene 蒸馏 | 从成功 Capsule 中 LLM 提炼新 Gene |
| **memoryGraph.js** | 771行 | 记忆图谱 | Jaccard 相似度 + Laplace 平滑 + 时间衰减 |
| **personality.js** | 355行 | 人格系统 | 5 维连续参数 + 自然选择 + 触发突变 |
| **mutation.js** | 186行 | 突变控制 | 风险分级（low/medium/high）+ 人格安全门 |
| **a2aProtocol.js** | 672行 | A2A 协议 | 6 种消息类型（hello/publish/fetch/report/decision/revoke） |
| **taskReceiver.js** | 467行 | 任务接收 | ROI 评分（bounty/capability/completion 加权） |
| **hubSearch.js** | 237行 | Hub 搜索 | 两阶段搜索（免费 metadata → 付费 payload） |
| **narrativeMemory.js** | 108行 | 叙事记忆 | Markdown 格式的人类可读进化日志 |

### 1.3 数据模型

**Gene（基因 — 可复用的解决方案模式）：**
```json
{
  "type": "Gene",
  "id": "gene_gep_repair_from_errors",
  "category": "repair|optimize|innovate",
  "signals_match": ["error", "exception", "failed"],
  "preconditions": ["signals contains error-related indicators"],
  "strategy": [
    "Extract structured signals from logs",
    "Select existing Gene by signals match",
    "Estimate blast radius before editing",
    "Apply smallest reversible patch",
    "Validate using declared validation steps",
    "Solidify knowledge: append EvolutionEvent"
  ],
  "constraints": { "max_files": 20, "forbidden_paths": [".git", "node_modules"] },
  "validation": ["node scripts/validate-modules.js ./src/evolve"]
}
```

**Capsule（胶囊 — 成功的执行实例）：**
```json
{
  "type": "Capsule",
  "id": "capsule_1710000000",
  "gene": "gene_gep_repair_from_errors",
  "trigger": ["log_error", "errsig:TypeError"],
  "summary": "Fixed null reference in message handler",
  "confidence": 0.85,
  "blast_radius": { "files": 2, "lines": 44 },
  "outcome": { "status": "success", "score": 0.85 },
  "success_streak": 3
}
```

**EvolutionEvent（进化事件 — 审计日志）：**
```json
{
  "type": "EvolutionEvent",
  "id": "evt_1710000000",
  "parent": "evt_1709999000",
  "intent": "repair",
  "signals": ["log_error", "errsig:TypeError"],
  "genes_used": ["gene_gep_repair_from_errors"],
  "personality_state": { "rigor": 0.7, "creativity": 0.35 },
  "blast_radius": { "files": 2, "lines": 44 },
  "outcome": { "status": "success", "score": 0.85 }
}
```

### 1.4 关键算法

#### Memory Graph（记忆图谱）

Evolver 最核心的学习机制。本质是一个 **(signal, gene) → outcome** 的置信度网络。

```
Signal 提取 → 信号归一化 → Jaccard 相似度匹配历史信号
                                    │
                         ┌──────────┴──────────┐
                         │  记忆图谱查询         │
                         │  对每个 Gene:          │
                         │  p = (success+1)/(n+2)│ ← Laplace 平滑
                         │  w = 0.5^(age/30d)    │ ← 时间衰减（半衰期 30 天）
                         │  score = p × w         │
                         └──────────┬──────────┘
                                    │
                         preferredGeneId + bannedGeneIds
```

- **Laplace 平滑**：`p = (success + 1) / (total + 2)`，防止 0/1 极端
- **时间衰减**：半衰期 30 天，偏向最近的经验
- **低效抑制**：成功率 < 18% 的 Gene 被封禁（除非开启漂变）
- **遗传漂变**：种群越小漂变越强（`intensity = 1/√Ne`），防止局部最优

#### Personality（人格系统）

5 维连续参数空间，通过自然选择 + 触发突变进化：

| 维度 | 默认值 | 作用 |
|------|--------|------|
| rigor | 0.7 | 协议严格度（高→保守，低→灵活） |
| creativity | 0.35 | 探索新方法的倾向 |
| verbosity | 0.25 | 输出详细度 |
| risk_tolerance | 0.4 | 接受高风险突变的阈值 |
| obedience | 0.85 | 遵循安全规则的程度 |

**自然选择**：追踪每个人格配置的历史成功率，向最佳配置靠拢（每次最多 ±0.1）。

**触发突变**：
- 遇到 error → rigor +0.1, risk_tolerance -0.1（变保守）
- 遇到 opportunity → creativity +0.1, risk_tolerance +0.05（变大胆）
- 协议偏移 → obedience +0.1, rigor +0.05（收紧规则）

**安全门**：rigor < 0.5 OR risk_tolerance > 0.6 → 禁止 innovate 类高风险突变。

#### Skill Distiller（技能蒸馏）

从累积的成功 Capsule 中提炼新 Gene：

```
累积 ≥ 10 个成功 Capsule
    │
    ├─ 按 Gene 分组统计
    ├─ 分析高频模式、策略漂移、覆盖空白
    │
    ▼
构建蒸馏 Prompt → LLM 生成新 Gene JSON
    │
    ├─ 验证：type/id/signals_match/strategy/constraints
    ├─ 去重：与现有 Gene 的 signals_match 不能完全重叠
    ├─ 安全：validation 命令只允许 node/npm/npx 前缀
    │
    ▼
写入 genes.json → 未来 cycle 可使用
```

**触发条件**：
- 成功 Capsule ≥ 10 个
- 最近 10 个 Capsule 中成功 ≥ 7 个
- 距上次蒸馏 ≥ 24 小时
- 数据 hash 与上次不同（有新数据）

### 1.5 A2A 协议与 Hub

Evolver 不仅本地进化，还通过 A2A 协议实现**跨 agent 知识共享**：

| 消息类型 | 方向 | 用途 |
|----------|------|------|
| `hello` | Agent → Hub | 能力广告 + 节点发现 |
| `publish` | Agent → Hub | 广播成功的 Gene/Capsule（带 HMAC 签名） |
| `fetch` | Agent ← Hub | 两阶段搜索：免费 metadata → 付费 full payload |
| `report` | Agent → Hub | 提交对复用资产的评分（1-5 星） |
| `decision` | Hub → Agent | 资产审核结果（accept/reject/quarantine） |
| `revoke` | Agent → Hub | 撤回有缺陷的资产 |

**任务市场**：Hub 可以推送任务给 agent，agent 通过 ROI 评分选择最优任务（bounty × capability / difficulty）。

---

## 二、与 Prismer 系统的映射分析

### 2.1 能力对照表

| Evolver 能力 | Prismer 对应 | 匹配度 | 说明 |
|-------------|-------------|--------|------|
| **Signal Extraction** | IM 消息 + Task 结果 + Event | 🟡 70% | Prismer 信号是结构化的（JSON），不需要从日志文本中解析 |
| **Gene Store** | im_memory_files (type: gene) | 🟢 90% | Memory Layer 已规划，Gene 是 memory file 的特殊类型 |
| **Gene Selection** | 纯算法，可直接移植 | 🟢 95% | selector.js 250 行，无外部依赖 |
| **Memory Graph** | im_compaction_summaries + im_memory_files | 🟡 60% | Memory Layer 的 compaction 覆盖了部分需求，但缺少 (signal, gene) → outcome 的置信度网络 |
| **GEP Prompt** | Agent system prompt 扩展 | 🟡 65% | Prismer 的 agent 通过 OpenClaw AI pipeline 执行，不直接控制 prompt |
| **Solidify** | Task complete + memory flush | 🔴 30% | Evolver 的 solidify 是代码修改验证（git diff），Prismer agent 不修改代码 |
| **Skill Distiller** | prismer_skill_distill tool | 🟡 70% | 从 Task 历史提炼 Gene 的逻辑可复用 |
| **Personality** | Agent metadata 扩展 | 🟢 85% | 5 维参数 + 自然选择，与 agent 注册时的 metadata 完美匹配 |
| **A2A Protocol** | IM 消息 + Event Subscriptions | 🟢 80% | Prismer IM 本身就是 A2A 通道，不需要单独的 A2A 协议 |
| **Hub Search** | prismer_discover + Context API | 🟡 65% | agent discover 已有，Gene 搜索需要新增 |
| **Task Receiver** | Task Store (Phase 1) + Scheduler (Phase 2) | ✅ 100% | 完全覆盖，Prismer 的实现更强（持久化、多 Pod） |
| **Lifecycle/Ops** | IM Server 常驻 + Scheduler | ✅ 100% | Cloud 进程管理不需要 PID 文件那套 |

### 2.2 核心差异

| 维度 | Evolver | Prismer |
|------|---------|---------|
| **运行位置** | Agent 本地进程 | Cloud 服务 |
| **进化对象** | 代码文件（git diff） | 任务执行策略、知识、工具使用模式 |
| **验证方式** | git rollback + node -e require | Task 结果评估（成功/失败/评分） |
| **存储** | 本地 JSONL 文件 | Cloud MySQL + API |
| **共享机制** | A2A 协议 + Hub | IM 消息 + Event Subscriptions（已有） |
| **安全模型** | forbidden_paths + blast_radius | Trust Tiers + Credit budget（已规划） |

### 2.3 关键洞察

**可以直接复用的：**
1. Gene/Capsule/EvolutionEvent 数据模型（结构完善，经过验证）
2. Selector 算法（信号匹配 + Laplace 平滑 + 遗传漂变）
3. Personality 系统（5 维参数 + 自然选择 + 触发突变）
4. Skill Distiller 的蒸馏逻辑（模式分析 + LLM 提炼 + 验证）

**需要重新设计的：**
1. **Signal Extraction** — Prismer 的信号源是结构化 IM 消息和 Task 结果，不是日志文本
2. **Solidify** — Prismer agent 不修改代码，验证逻辑是 "Task 执行是否成功"
3. **GEP Prompt** — Prismer 不直接控制 LLM prompt（通过 OpenClaw pipeline），Gene 的 strategy 需要转化为 agent tool 调用序列
4. **A2A 共享** — 不需要独立协议，直接用 IM 消息 + memory_files API

**不需要的：**
1. git rollback / blast_radius（Cloud 上没有代码文件操作）
2. PID 文件 / lifecycle.js（Cloud 进程由 K8s 管理）
3. skills_monitor.js（OpenClaw 特有的 skill 目录结构检查）
4. self_repair.js（git 修复，不适用）

---

## 三、Prismer Skill Evolution 设计

### 3.1 架构定位

将 Evolver 的核心进化能力**云端化**，融入 Prismer 已有的三大支柱：

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Prismer Cloud Evolution Layer                      │
│                                                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │ Gene Store  │  │   Memory    │  │  Scheduler  │                  │
│  │ (memory_    │  │   Graph     │  │  (Phase 2)  │                  │
│  │  files API) │  │ (新增表)    │  │             │                  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                  │
│         │                │                │                          │
│         └────────────────┼────────────────┘                          │
│                          │                                            │
│              ┌───────────┴───────────┐                                │
│              │   Evolution Service   │   信号分析 → Gene 选择 →       │
│              │   (IM Server 内)      │   Prompt 构建 → 推送给 Agent   │
│              └───────────┬───────────┘                                │
│                          │                                            │
└──────────────────────────┼────────────────────────────────────────────┘
                           │ IM message (type: "evolution_advice")
                           │ or Tool response
              ┌────────────┼────────────────┐
              ▼            ▼                ▼
         ┌─────────┐ ┌─────────┐      ┌─────────┐
         │ Agent A  │ │ Agent B  │      │ Agent C  │
         │ 接收进化  │ │ 共享 Gene│      │ 蒸馏新   │
         │ 建议     │ │ 到网络   │      │ Gene     │
         └─────────┘ └─────────┘      └─────────┘
```

**核心原则：**
- Gene Store 复用 Memory Layer 的 `im_memory_files`（`path: "genes/*.json"`）
- Memory Graph 作为新的 Cloud 表（`im_evolution_edges`），记录 signal→gene→outcome
- Evolution Service 嵌入 IM Server，不是独立进程
- Agent 通过 IM 工具（`prismer_evolve`）触发进化分析

### 3.2 数据模型

#### Gene（复用 im_memory_files）

Gene 存储为 Memory files 的特殊子类型：

```
im_memory_files:
  owner_id:  agent-001
  owner_type: agent
  scope:     global
  path:      genes/repair_api_timeout.json
  content:   { "type": "Gene", "id": "gene_repair_api_timeout", ... }
```

Gene JSON 结构（适配 Prismer 场景）：

```typescript
interface PrismerGene {
  type: "Gene";
  id: string;                          // gene_<descriptive_name>
  category: "repair" | "optimize" | "innovate";

  // 信号匹配（何时触发）
  signals_match: string[];             // ["task.failed", "api_timeout", "retry_exhausted"]
  preconditions: string[];             // ["previous task was API call"]

  // 策略（做什么）— 适配为 tool 调用序列而非代码修改步骤
  strategy: string[];                  // [
                                       //   "Check if endpoint is responding (prismer_load)",
                                       //   "If timeout: switch to cached version",
                                       //   "Report result to task creator",
                                       //   "Update memory with endpoint status"
                                       // ]

  // 约束
  constraints: {
    max_credits: number;               // 单次最多消耗的 credits（替代 max_files）
    max_retries: number;               // 最大重试次数
    required_capabilities: string[];   // 执行此 Gene 需要的 agent 能力
  };

  // 统计
  success_count: number;
  failure_count: number;
  last_used_at: string;                // ISO timestamp

  // 元数据
  created_by: string;                  // agent ID
  distilled_from?: string[];           // 蒸馏来源的 capsule IDs
}
```

#### Capsule（新增轻量表 or 复用 im_task_logs）

每次 Gene 执行的结果记录。**复用 `im_task_logs`**，增加 evolution 相关字段：

```typescript
// im_task_logs 中 action = 'evolution_outcome' 的记录
interface EvolutionCapsule {
  task_id: string;
  actor_id: string;                    // 执行的 agent
  action: "evolution_outcome";
  metadata: {
    type: "Capsule";
    gene_id: string;                   // 使用的 Gene
    trigger_signals: string[];         // 触发信号
    summary: string;                   // 一句话结果
    confidence: number;                // 0-1
    outcome: { status: "success" | "failed"; score: number };
    cost_credits: number;              // 实际消耗
  };
}
```

#### Evolution Edge（新增表）

记忆图谱的核心：(signal_key, gene_id) → 置信度。

```sql
CREATE TABLE im_evolution_edges (
  id            VARCHAR(36) PRIMARY KEY,
  signal_key    VARCHAR(500) NOT NULL,   -- 归一化信号组合 "api_timeout|task.failed"
  gene_id       VARCHAR(100) NOT NULL,   -- 引用的 Gene
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  last_score    DECIMAL(5,4),            -- 最近一次的 outcome score
  last_used_at  DATETIME,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE INDEX idx_signal_gene (signal_key, gene_id),
  INDEX idx_gene (gene_id)
);
```

#### Agent Personality（扩展 im_agents 表）

在现有 `im_agents` 表的 `metadata` JSON 字段中增加 personality：

```typescript
// im_agents.metadata 扩展
interface AgentPersonality {
  personality: {
    rigor: number;           // 0-1, default 0.7
    creativity: number;      // 0-1, default 0.35
    risk_tolerance: number;  // 0-1, default 0.4
    // 精简为 3 维（去掉 verbosity 和 obedience，这两个在 Cloud 场景中意义不大）
  };
  personality_stats: {
    [configKey: string]: {   // key = "r0.7_c0.4_t0.4"
      success: number;
      failure: number;
      avg_score: number;
    };
  };
}
```

### 3.3 Evolution Service

嵌入 IM Server 的进化分析服务：

```typescript
// src/im/services/evolution.service.ts

export class EvolutionService {

  // ===== 信号分析 =====

  /**
   * 从 Task 结果中提取进化信号
   * Evolver 从日志文本中 NLP 提取，我们从结构化数据中直接提取
   */
  extractSignals(task: Task, logs: TaskLog[]): string[] {
    const signals: string[] = [];

    // 任务状态信号
    if (task.status === 'failed') signals.push('task.failed');
    if (task.status === 'completed') signals.push('task.completed');
    if (task.result?.timeout) signals.push('timeout');

    // 错误类型信号
    if (task.error) {
      const normalized = this.normalizeError(task.error);
      signals.push(`error:${normalized}`);
    }

    // 能力信号
    if (task.capability) signals.push(`capability:${task.capability}`);

    // 模式信号（从历史中检测）
    const recentFails = await this.getRecentFailures(task.assignee_id, 10);
    if (recentFails >= 3) signals.push('recurring_failure');
    if (recentFails === 0 && /* 连续 10 个成功 */) signals.push('stable_success');

    return signals;
  }

  // ===== Gene 选择 =====

  /**
   * 基于信号和记忆图谱选择最佳 Gene
   * 算法直接移植自 Evolver selector.js
   */
  async selectGene(signals: string[], agentId: string): Promise<{
    gene: PrismerGene | null;
    alternatives: PrismerGene[];
    confidence: number;
  }> {
    // 1. 加载该 agent 的所有 Gene
    const genes = await this.loadGenes(agentId);

    // 2. 查询记忆图谱获取建议
    const signalKey = this.computeSignalKey(signals);
    const edges = await this.getEvolutionEdges(signalKey);
    const advice = this.computeMemoryAdvice(edges, genes);

    // 3. 评分选择（移植 Evolver 的 selectGene 逻辑）
    // - 信号匹配评分
    // - Memory graph 偏好/封禁
    // - 遗传漂变（种群小时随机探索）
    // - Laplace 平滑置信度
    return this.scoreAndSelect(genes, signals, advice);
  }

  // ===== 进化建议 =====

  /**
   * 生成进化建议推送给 Agent
   * 替代 Evolver 的 GEP prompt（我们不直接控制 LLM，而是通过 IM 消息传递建议）
   */
  async generateAdvice(task: Task): Promise<EvolutionAdvice> {
    const signals = await this.extractSignals(task);
    const { gene, confidence } = await this.selectGene(signals, task.assignee_id);

    if (!gene) return { action: 'none', reason: 'no matching gene' };

    return {
      action: 'apply_gene',
      gene_id: gene.id,
      strategy: gene.strategy,          // agent 可执行的步骤列表
      confidence,
      signals,
      constraints: gene.constraints,
    };
  }

  // ===== 结果记录 =====

  /**
   * Task 完成后记录进化结果
   * 更新记忆图谱 + Gene 统计 + 人格调整
   */
  async recordOutcome(task: Task, geneId: string, outcome: Outcome): Promise<void> {
    // 1. 更新 evolution edge
    const signalKey = this.computeSignalKey(task.signals);
    await this.upsertEdge(signalKey, geneId, outcome);

    // 2. 更新 Gene 统计
    await this.updateGeneStats(geneId, outcome);

    // 3. 人格自然选择
    await this.updatePersonality(task.assignee_id, outcome);

    // 4. 检查是否应该蒸馏
    if (await this.shouldDistill(task.assignee_id)) {
      await this.triggerDistillation(task.assignee_id);
    }
  }

  // ===== Gene 蒸馏 =====

  /**
   * 从成功的 Task 历史中提炼新 Gene
   * 移植 Evolver 的 skillDistiller 逻辑
   */
  async triggerDistillation(agentId: string): Promise<PrismerGene | null> {
    // 1. 收集成功 capsules
    const capsules = await this.getSuccessCapsules(agentId, 50);
    if (capsules.length < 10) return null;

    // 2. 分析模式（高频、策略漂移、覆盖空白）
    const analysis = this.analyzePatterns(capsules);

    // 3. 构建蒸馏 prompt
    const existingGenes = await this.loadGenes(agentId);
    const prompt = this.buildDistillationPrompt(analysis, existingGenes);

    // 4. LLM 调用（使用配置的默认模型）
    const response = await this.callLLM(prompt);

    // 5. 验证 + 去重 + 写入
    const gene = this.validateSynthesizedGene(response, existingGenes);
    if (gene) {
      await this.saveGene(agentId, gene);
    }
    return gene;
  }
}
```

### 3.4 Agent Tools（OpenClaw + MCP）

```typescript
// OpenClaw channel plugin 新增 tools

// prismer_evolve_analyze: 分析当前状况，获取进化建议
{
  name: "prismer_evolve_analyze",
  description: "Analyze recent task outcomes and get evolution advice",
  parameters: { context?: string },
  execute: async (_, args) => {
    // POST /api/im/evolution/analyze
    // 返回: { signals, gene, strategy, confidence }
  }
}

// prismer_evolve_record: 记录执行结果
{
  name: "prismer_evolve_record",
  description: "Record the outcome of applying an evolution strategy",
  parameters: {
    gene_id: string,
    outcome: "success" | "failed",
    score?: number,    // 0-1
    summary: string
  },
  execute: async (_, args) => {
    // POST /api/im/evolution/record
    // 更新 memory graph + gene stats + personality
  }
}

// prismer_gene_create: 手动创建 Gene
{
  name: "prismer_gene_create",
  description: "Create a reusable evolution gene from a successful pattern",
  parameters: {
    category: "repair" | "optimize" | "innovate",
    signals_match: string[],
    strategy: string[],
    constraints?: object
  },
  execute: async (_, args) => {
    // POST /api/im/memory/files (path: genes/<id>.json)
  }
}
```

### 3.5 API Endpoints

```
POST   /api/im/evolution/analyze          分析信号，返回进化建议
POST   /api/im/evolution/record           记录进化结果
POST   /api/im/evolution/distill          触发 Gene 蒸馏
GET    /api/im/evolution/genes             列出可用 Gene (?signals=X)
GET    /api/im/evolution/edges             查询记忆图谱
GET    /api/im/evolution/personality/:id   查询 agent 人格状态
GET    /api/im/evolution/report            进化报告（统计 + 趋势）
```

### 3.6 与三大支柱的集成

| 支柱 | 集成点 | 新增工作 |
|------|--------|---------|
| **Agent Orchestration** | Task complete → `evolution.recordOutcome()` 自动触发 | Hook 到 task lifecycle |
| **Agent Orchestration** | Scheduler 定期运行 `evolution.distill()` | Scheduler task type |
| **Agent Orchestration** | Event subscription: `evolution.gene_created` | 新 event type |
| **E2E Encryption** | Gene 包含策略信息，遵循 Trust Tier 分级 | 无额外工作 |
| **Memory Layer** | Gene 存储复用 `im_memory_files` | 无额外表 |
| **Memory Layer** | Capsule 复用 `im_task_logs` | metadata 扩展 |
| **Memory Layer** | Memory flush 时检查是否有可蒸馏的 Gene | Hook 到 flush |

---

## 四、实现难度评估

### 4.1 工作量拆解

| 工作项 | 复杂度 | 工作量 | 依赖 |
|--------|--------|--------|------|
| `im_evolution_edges` 表 + Prisma model | 🟢 简单 | 1 天 | — |
| Agent personality metadata 扩展 | 🟢 简单 | 0.5 天 | — |
| `EvolutionService.extractSignals()` | 🟢 简单 | 1 天 | Task Store |
| `EvolutionService.selectGene()` (移植 selector.js) | 🟡 中等 | 2 天 | Gene Store |
| `EvolutionService.recordOutcome()` + edge 更新 | 🟡 中等 | 1.5 天 | im_evolution_edges |
| `EvolutionService.triggerDistillation()` | 🟡 中等 | 2.5 天 | LLM 调用 |
| Personality 自然选择 + 触发突变 | 🟡 中等 | 1.5 天 | — |
| Evolution API (6 endpoints) | 🟡 中等 | 2 天 | EvolutionService |
| OpenClaw tools (3 tools) | 🟢 简单 | 1 天 | Evolution API |
| MCP server tools (2 tools) | 🟢 简单 | 0.5 天 | Evolution API |
| SDK client methods (TS/Python/Go) | 🟡 中等 | 2 天 | Evolution API |
| Task lifecycle hook (complete → record) | 🟢 简单 | 0.5 天 | Phase 1 |
| **合计** | — | **~16 天** | — |

### 4.2 与 v1.7.2 的关系

**建议：作为 v1.7.2 的第四支柱，但标记为 "Phase S — Skill Evolution (可选)"。**

理由：
1. 核心依赖（Task Store, Memory Layer）都在 v1.7.2 其他三大支柱中实现
2. Evolution Service 是这些基础设施的**自然延伸**，不是独立系统
3. 16 天工作量可控，且大部分是算法移植（selector, personality, distiller）
4. 如果时间紧张，可以先实现 Phase S1（Gene Store + Selection），Phase S2（Distiller + Personality）延后

### 4.3 分阶段实施

#### Phase S1: Gene Store + Selection（~7 天）
- [ ] `im_evolution_edges` 表
- [ ] Agent personality metadata 扩展
- [ ] `EvolutionService` 核心：extractSignals, selectGene, recordOutcome
- [ ] Evolution API: analyze, record, genes, edges
- [ ] Task lifecycle hook: complete → recordOutcome

**产出：** Agent 执行 task 时，系统自动记录 (signal, gene) → outcome，未来再遇到相同信号时推荐最佳 Gene。

#### Phase S2: Distiller + Personality（~5 天）
- [ ] `triggerDistillation()` — LLM 从成功历史提炼新 Gene
- [ ] Personality 自然选择 + 触发突变
- [ ] Scheduler 定时蒸馏任务
- [ ] Evolution API: distill, personality, report

**产出：** Agent 自动从历史中学习，提炼新的可复用策略，人格随成败自适应调整。

#### Phase S3: Agent Tools + SDK（~4 天）
- [ ] OpenClaw tools: prismer_evolve_analyze, prismer_evolve_record, prismer_gene_create
- [ ] MCP server tools: evolve_analyze, evolve_record
- [ ] SDK client methods: client.im.evolution.*（TS/Python/Go）

**产出：** Agent 可以主动触发进化分析、记录结果、创建 Gene，完成闭环。

---

## 五、关键决策

### Q1: Gene 共享范围？

**建议：同一 owner 的所有 agent 共享 Gene（`scope: global`），跨 owner 不共享。**

Evolver 的 Hub 共享模式在 Prismer 中的对应是：agent A 发现了一个好的 Gene → 通过 IM 消息（`type: evolution_share`）发给 agent B → B 可以导入到自己的 Gene Store。

跨 owner 共享（公开 Gene 市场）属于 Agent Economy (v0.8.0+) 的范畴，不在 v1.7.2 实现。

### Q2: 蒸馏用哪个 LLM？

**建议：使用 Cloud 默认的低成本模型（GPT-4o-mini）。** 蒸馏不需要最强模型，因为它处理的是结构化数据（Capsule JSON → Gene JSON），不是创造性任务。通过 Nacos 配置可切换。

### Q3: 遗传漂变在 Cloud 场景中有意义吗？

**有意义。** 遗传漂变防止 agent 陷入局部最优。例如：agent 一直用同一个 Gene 处理 API 超时，但实际上有更好的策略（如切换到缓存）。漂变概率与 Gene 数量负相关（Gene 少时漂变高，鼓励探索）。

### Q4: 进化与 E2E 加密的关系？

Gene 中的 `strategy` 字段包含具体的执行策略，属于 agent 的知识资产。应遵循 E2E 加密的 Trust Tier 分级：
- Tier 0-1（自己/受信 agent）：Gene 明文存储
- Tier 2+（不受信 agent）：Gene 的 `summary` 明文（用于匹配），`strategy` 加密

### Q5: 与 Evolver 的 SKILL.md / OpenClaw skill 目录结构的关系？

**不对应。** Evolver 的 "skill" 是 OpenClaw 的目录约定（`skills/<name>/SKILL.md + index.js`）。Prismer 的 Gene 不是 OpenClaw skill，而是存储在 Cloud 中的**策略知识**。Agent 根据 Gene 的 strategy 调用 Prismer tools，而不是创建新的 skill 目录。

---

## 六、不实现的（与 Evolver 的差异）

| Evolver 功能 | 不实现原因 |
|-------------|-----------|
| **git rollback / blast_radius** | Prismer agent 不修改代码文件 |
| **forbidden_paths** | 替换为 `max_credits` 约束（经济限制替代文件限制） |
| **validation commands** (`node -e require`) | 替换为 Task 结果评估 |
| **PID file / lifecycle.js** | Cloud 由 K8s 管理 |
| **skills_monitor.js** | OpenClaw 特有 |
| **self_repair.js** | git 修复不适用 |
| **A2A file transport** | 直接用 IM API |
| **Hub registration / heartbeat** | Agent 已有 heartbeat（IM agent protocol） |
| **Commentary personas** | 装饰性功能，非核心 |
| **Constitutional ethics prompt** | 通过 Trust Tier + Credit budget 实现同等安全 |

---

## 6.1、Skill Catalog — Evolution 基础设施（v1.7.2 实现）

### 问题

Evolution 算法（Laplace smoothing, genetic drift, personality）操作的数据集只有 45 个静态 JSON gene。没有基本的 skill 搜索、管理、发布、展示、排名机制，也没有从外部源同步的能力。这就像在只有 45 个物种的星球上搞自然选择。

**正确顺序：Skill Catalog（基础设施）→ Evolution（算法）**

### 实现

#### 数据模型：`im_skills` 表

```
im_skills
├── id, slug (unique)        — 标识
├── name, description        — 展示
├── category, tags           — 分类
├── author, source, sourceId — 来源追踪 (clawhub|awesome-openclaw|community|prismer)
├── sourceUrl                — 原始链接
├── content                  — 完整 SKILL.md 或策略文本
├── installs, stars          — 排名指标
├── status                   — active|deprecated|pending_review
├── geneId                   — 关联的 Evolution Gene（可选）
└── metadata                 — JSON 扩展字段
```

#### API 端点

| 端点 | Auth | 用途 |
|------|------|------|
| `GET /api/im/skills/search` | No | 搜索浏览 (?query=&category=&source=&sort=&page=&limit=) |
| `GET /api/im/skills/stats` | No | 全局统计 (total, by_source, by_category) |
| `GET /api/im/skills/categories` | No | 分类列表 + 计数 |
| `GET /api/im/skills/:slug` | No | Skill 详情 |
| `POST /api/im/skills/import` | Yes | 批量导入 (max 5000/次) |
| `POST /api/im/skills/sync/raw` | Yes | 从 raw-skills.json 格式导入 |
| `POST /api/im/skills` | Yes | 社区提交 |
| `PATCH /api/im/skills/:id` | Yes | 更新 |
| `DELETE /api/im/skills/:id` | Yes | 软删除 (deprecated) |
| `POST /api/im/skills/:id/install` | No | 记录安装 |

#### 数据源

| Source | Skills | 覆盖 |
|--------|--------|------|
| awesome-openclaw-skills | 5,494 (20 categories) | Tier 1-3 分批导入 |
| raw-skills.json (已获取) | 2,751 (7 categories) | **已导入** |
| ClawHub (clawhub.ai) | 13,729 | 待接入 API |
| community | 0 | 用户提交 |

#### Bootstrap 脚本

```bash
# 1. 获取原始数据（已有 7 categories，扩展到 20+）
npx tsx scripts/seed/fetch-openclaw-skills.ts

# 2. 导入到 im_skills 表
npx tsx scripts/seed/bootstrap-skill-catalog.ts

# 3. 验证
curl http://localhost:3200/api/skills/stats
# → { total: 2748, by_source: { "awesome-openclaw": 2748 }, by_category: {...} }
```

#### Skill → Gene 连接

Skill Catalog 是 raw material，Evolution Gene 是 refined strategy：
- Skill = 外部能力描述（"what it does"）
- Gene = 可执行策略模式（"how to solve this signal pattern"）
- 未来：LLM 将 skill content 蒸馏为 gene（signals_match + strategy steps）
- `im_skills.geneId` 字段记录转化关系

---

## 七、已知架构债务与后续计划

### 7.1 Gene 存储迁移：metadata JSON → 独立 im_genes 表

**当前问题：** Gene 存储在 `IMAgentCard.metadata` 的 JSON blob 中。

| 问题 | 影响 |
|------|------|
| 全量读写 | 每次 CRUD 都要 parse → modify → stringify 整个 metadata |
| 无并发安全 | 两个请求同时修改 metadata → 后写者覆盖先写者 |
| 公开查询低效 | `getAllPublicGenes()` 必须 `findMany` 全部 agent 然后内存过滤 |
| 无法按 Gene 建索引 | 搜索、排序、聚合全靠应用层 |
| 跨 agent 统计依赖 capsules 表 | seed gene 的 success_count/failure_count 永远是 0（已通过聚合修复） |

**迁移计划（v1.8.0）：**

```sql
CREATE TABLE IF NOT EXISTS im_genes (
  id            VARCHAR(128) NOT NULL PRIMARY KEY,
  ownerAgentId  VARCHAR(30)  NOT NULL,           -- 创建者 agent
  category      VARCHAR(20)  NOT NULL DEFAULT 'repair',
  title         VARCHAR(256) DEFAULT NULL,
  description   TEXT,
  signalsMatch  JSON         NOT NULL,           -- string[]
  preconditions JSON         DEFAULT '[]',
  strategy      JSON         NOT NULL,           -- string[]
  constraints   JSON         DEFAULT '{}',
  visibility    VARCHAR(20)  NOT NULL DEFAULT 'private',  -- private|published|seed
  successCount  INT          NOT NULL DEFAULT 0,
  failureCount  INT          NOT NULL DEFAULT 0,
  lastUsedAt    DATETIME(3)  DEFAULT NULL,
  createdBy     VARCHAR(128) DEFAULT NULL,        -- prismer:seed | distillation | agentId
  createdAt     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_owner (ownerAgentId),
  INDEX idx_visibility (visibility),
  INDEX idx_category (category),
  INDEX idx_usage (successCount DESC, failureCount DESC)
);
```

**迁移步骤：**
1. 创建 `im_genes` 表 + Prisma model
2. 写迁移脚本：从所有 agent 的 metadata.genes 提取到 im_genes
3. 改 EvolutionService 方法逐个切换到 Prisma 查询
4. 删除 metadata.genes 依赖
5. 公开 API 直接 `WHERE visibility IN ('published', 'seed')` — O(1) 索引查询

### 7.2 SDK Auto-Evolution（设计点位，待实现）

**目标：** SDK 层自动触发 evolution record，无需 agent 开发者手动调用 API。

**设计：**

```typescript
// SDK 配置
const prismer = new PrismerSDK({
  apiKey: 'sk-prismer-...',
  evolution: {
    enabled: true,           // 默认 false
    autoRecord: true,        // task 完成/失败时自动 POST /evolution/record
    autoAnalyze: true,       // task 开始前自动 POST /evolution/analyze
  },
});

// SDK 内部 — task 生命周期 hook
class TaskClient {
  async execute(task: Task) {
    // 1. Auto-analyze: get gene recommendation before execution
    if (this.config.evolution?.autoAnalyze) {
      const advice = await this.evolution.analyze({
        task_status: 'pending',
        task_capability: task.capability,
        tags: task.tags,
      });
      // Inject strategy hints into task context
      if (advice.strategy) task.context.evolutionHints = advice.strategy;
    }

    // 2. Execute task...
    const result = await this.doExecute(task);

    // 3. Auto-record: report outcome after execution
    if (this.config.evolution?.autoRecord && advice?.gene_id) {
      await this.evolution.record({
        gene_id: advice.gene_id,
        signals: advice.signals,
        outcome: result.success ? 'success' : 'failed',
        score: result.score,
        summary: result.summary,
      });
    }

    return result;
  }
}
```

**MCP Server 集成：** `evolve_analyze` 和 `evolve_record` 两个 tool 已存在，可被 Claude Code/Cursor 等 MCP client 调用。当 SDK auto-evolution 实现后，这些 tool 变为可选（手动触发）。

**IM 消息 hook：** 另一个触发路径 — agent 发送消息时，IM server 可检查消息是否包含 task 结果（如 `task.completed` 或 `task.failed` tag），自动创建 evolution record。这需要 `src/im/services/messages.ts` 中的 message post-processing hook。

**优先级：** v1.8.0+（需先完成 im_genes 表迁移 + Agent Orchestration Task 系统）

### 7.3 与 EvoMap 的关系

**明确定位：** Prismer 不接 EvoMap 的 A2A 协议。两个系统是独立的。

| 维度 | EvoMap A2A | Prismer IM |
|------|-----------|-----------|
| 协议 | GEP-A2A v1.0.0（自有协议） | Prismer IM API（自有协议） |
| 发现 | `/a2a/hello` + heartbeat | `/api/im/discover` + agent registry |
| 消息 | 无（asset 发布为主） | WebSocket + SSE + REST |
| Gene 交换 | `/a2a/publish` → 公开市场 | `/evolution/genes/:id/publish` → Prismer market |

**数据复用：** 可以从 EvoMap 市场的公开 Gene 中提取优质策略作为 seed gene（已有 `seed-genes-external.json` 中 7 个 EvoMap 来源的 gene）。但这是**单向数据导入**，不是协议集成。

---

*Last updated: 2026-03-10*
