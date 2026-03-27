# Wolfram 超图改造 Evolution Engine — 理论推演

> **Version:** 0.2
> **Date:** 2026-03-18
> **Status:** 探索性分析 → 可验证设计
> **前置:** EVOLUTION-ENGINE.md v0.3.0（当前架构）
> **核心问题：** 用 Wolfram Physics Project 的超图（Hypergraph）+ 重写规则（Rewrite Rules）框架重新审视进化引擎，能带来什么、代价是什么、值不值得。

---

## 1. 当前架构的图论本质

先把当前系统用图论语言精确描述，才能看清超图改造到底改了什么。

### 1.1 当前：二部图 + 聚合缓存

```
当前数据模型的图论结构：

G = (V, E)  其中
  V = V_signal ∪ V_gene ∪ V_agent
  E ⊆ V_signal × V_gene              ← 二元关系（binary edge）

每条边 e = (s, g) 携带属性：
  α(e), β(e)       — Beta 后验参数
  bimodality(e)     — 超额分散指数
  coverage_level(e) — 匹配精细度
  last_used_at(e)   — 时间衰减锚点

聚合语义：
  α(s,g) = Σ_{所有产生此 edge 更新的 capsule c} success(c) + 1
```

**关键观察：这是一个 2-uniform hypergraph（所有超边恰好连接 2 个元素）的特殊情况。** 这不是选择，是限制——因为 SQL 的行模型天然编码二元关系。

### 1.2 被压缩掉的维度

当 Agent A 在 OpenAI API 调用阶段遇到 error:500 并使用 Gene X 成功修复时，实际发生的关系是：

```
(Agent_A, error:500, openai, api_call, critical, Gene_X, context_hash_abc) → success
```

这是一个 **7 元关系**。但在当前 schema 中它被压缩为：

```
im_evolution_edges:  signal_key="error:500|openai|api_call", gene_id="Gene_X"
                     → α += 1
```

维度压缩清单：

- `Agent_A` → 被 owner_agent_id 保留，但全局聚合时丢失
- `openai` → 被压进 signal_key 的 `|` 分隔字符串
- `api_call` → 同上
- `critical` → 完全丢失
- `context_hash_abc` → 完全丢失
- 因果关系 → 完全丢失（不知道这个 success 是因为什么之前的 failure 触发的学习）

§3.4 的 SignalTag 设计部分解决了 `provider/stage/severity` 的丢失，但因果关系和上下文依然被折叠。

---

## 2. Wolfram 超图框架：核心概念映射

### 2.1 超图基础

Wolfram Physics Project 的核心结构：

```
超图 H = (V, E_hyper)
  V = 原子集合（atoms）
  E_hyper = { {v₁, v₂, ..., vₖ} | vᵢ ∈ V }    ← k 可以不同（变长超边）

重写规则 R: pattern → replacement
  例: {x, y, z} → {x, y}, {y, w}, {z, w}
  含义: 一条 3 元超边被替换为两条 2 元超边 + 一个新节点 w

演化: 反复对超图应用重写规则 → 涌现出类时空结构
```

### 2.2 映射到进化引擎

| Wolfram 概念                       | 进化引擎映射                                      | 说明                                                                    |
| ---------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| **原子 (Atom)**                    | Agent, SignalTag 各维度值, Gene, Context fragment | 最小不可分实体                                                          |
| **超边 (Hyperedge)**               | Capsule 事件                                      | 一次执行连接所有相关实体                                                |
| **重写规则 (Rewrite Rule)**        | Gene strategy                                     | Gene 接收一个模式（signal + context），产出新状态（outcome + 学习更新） |
| **规则应用 (Rule Application)**    | `selectGene()` + Agent 执行 + `recordOutcome()`   | 一个完整的进化步                                                        |
| **因果图 (Causal Graph)**          | Capsule 间的因果链                                | C₁ 的 outcome 影响 edge，edge 影响 C₂ 的 Gene 选择                      |
| **多路系统 (Multiway System)**     | 不同 Agent 对同一 Signal 选择不同 Gene            | 探索空间的并行分支                                                      |
| **分枝空间 (Branchial Space)**     | Agent 策略差异度量                                | 两个 Agent 的"分枝距离" = 策略路径的历史分歧程度                        |
| **规则空间 (Rulial Space)**        | Gene 库全体                                       | 所有可能的策略规则构成的空间                                            |
| **因果不变性 (Causal Invariance)** | 聚合的交换律                                      | Beta 参数 α += Δ 的更新顺序不影响最终值                                 |

### 2.3 超边的具体形态

```typescript
// 当前：二元 edge
type BinaryEdge = [SignalKey, GeneId];

// 超图：N 元超边（Capsule 就是超边）
type Hyperedge = {
  id: string;
  elements: Set<Atom>; // 参与的所有原子
  type: 'execution' | 'routing' | 'causation' | 'distillation';
  metadata: Record<string, unknown>;
};

// 原子类型
type Atom =
  | { kind: 'agent'; id: string }
  | { kind: 'signal_type'; value: string } // "error:500"
  | { kind: 'provider'; value: string } // "openai"
  | { kind: 'stage'; value: string } // "api_call"
  | { kind: 'severity'; value: string } // "critical"
  | { kind: 'gene'; id: string }
  | { kind: 'context'; hash: string } // execution context fingerprint
  | { kind: 'outcome'; value: 'success' | 'failed' };
```

**一条执行超边的实例：**

```
Hyperedge {
  id: "cap_20260318_001",
  elements: {
    agent:A1,
    signal_type:"error:500",
    provider:"openai",
    stage:"api_call",
    severity:"transient",
    gene:"500_Error_Triage",
    context:"ctx_hash_7f3a",
    outcome:"success"
  },
  type: "execution"
}
```

这条超边同时参与 8 个原子——在二部图中需要多次投影才能表达的信息，在超图中是一个原子操作。

---

## 3. 理论层面推演

### 3.1 Signal 开放空间问题的结构性消解

**当前问题（EVOLUTION-ENGINE.md §3.4）：**
`error:500` 不是一个点，覆盖数十万种不同情景。把它们折叠进同一个 edge 使 confidence 成为无意义的平均数。

**当前解法：** SignalTag[] 层级标签 + tagCoverageScore() 子集匹配。

**超图解法：** 不需要"层级标签"这个设计——每个维度（type, provider, stage, severity）是独立的原子节点，超边自然关联它们。查询变成超图模式匹配：

```
查询: 找到所有包含 {signal_type:"error:500", provider:"openai"} 的超边中，
      与哪些 gene 原子共现？

等价 SQL:
SELECT gene_id, COUNT(*) as cooccurrence
FROM hyperedges h
WHERE h.elements @> '{"signal_type":"error:500","provider":"openai"}'
GROUP BY gene_id
ORDER BY cooccurrence DESC
```

**维度不再被"折叠"或"拼接"成字符串**——它们是超图中的独立节点。`tagCoverageScore()` 的子集匹配逻辑变成了超图的原生查询操作。

**理论优势：** 新增维度（如 `region`, `time_of_day`, `load_level`）不需要修改 Signal 架构——只需添加新的原子类型，超边自然包含它们。当前 `[key: string]: string | undefined` 的可扩展索引签名在类型层面做了这件事，但在存储层（signal_key 字符串拼接）仍然是退化的。

### 3.2 因果图：从"聚合缓存"到"因果追踪"

**当前问题：** Edge 是 Capsule 的聚合缓存（EVOLUTION-ENGINE.md §3.2: "Edge 只是 Capsule 的聚合缓存"）。聚合过程丢失因果关系。

```
Agent A 对 Gene X 记录 success → α(s,g) += 1
Agent B 读取更新后的 edge → 选择 Gene X → 又 success → α(s,g) += 1

因果链：A_success → edge_update → B_selection → B_success
当前系统中这条链不可见。
```

**超图因果图：**

```
Capsule_A {agent:A, gene:X, outcome:success}
    ↓ (causes)
Edge_Update {signal:s, gene:X, Δα:+1}
    ↓ (causes)
Selection_B {agent:B, signal:s, selected:gene:X, because:routing_weight=0.87}
    ↓ (causes)
Capsule_B {agent:B, gene:X, outcome:success}
```

每个箭头是一条 **因果超边**（type: 'causation'），连接 cause 事件和 effect 事件。

**可以回答当前系统无法回答的问题：**

1. **归因分析：** "Gene X 的高路由权重是被哪些 Agent 的哪些执行建立起来的？" → 沿因果图回溯
2. **传播影响估计：** "如果 Agent A 的那次 success 实际上是 phantom success（Evolver 的 0.6 噪声问题），它污染了多少下游决策？" → 因果图前向遍历
3. **反事实推演：** "如果 Agent A 当时选了 Gene Y 而不是 Gene X，后续的决策链会怎样？" → 因果图剪枝 + 重放

### 3.3 多路系统：探索-利用的拓扑结构

**当前实现：** Thompson Sampling 通过从 Beta 后验采样自然产生多路分支——不同 Agent 在同一时刻可能采样到不同的值，选择不同的 Gene。但这个分支结构是隐式的。

**超图多路系统使其显式：**

```
                    Signal: error:500
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
         Agent A     Agent B     Agent C
         选择 Gene X  选择 Gene Y  选择 Gene X
              │          │          │
              ▼          ▼          ▼
           success     failed     success
              │          │          │
              └──────┬───┘──────────┘
                     ▼
              系统学到什么？

分枝距离:
  d(A, C) = 0  （同一分支：选了同一个 Gene）
  d(A, B) = 1  （不同分支：选了不同 Gene）
  d(B, C) = 1
```

**分枝距离的实用价值：**

- 当前 Pooled Prior 对所有 Agent 一视同仁地池化 α/β
- 超图方案：**按分枝距离加权池化**——策略路径相似的 Agent 经验权重更高，策略路径完全不同的 Agent 经验权重低（因为它们可能在解决完全不同的问题变体）
- 这直接改进 §4.2 Pooled Prior 的跨粒度聚合策略

### 3.4 因果不变性：并发安全的理论保证

**Wolfram 的因果不变性原理：** 如果重写规则的应用顺序不影响最终结果（汇合性），则系统具有因果不变性。

**检验当前系统：**

| 操作                   | 交换律？ | 分析                                                 |
| ---------------------- | -------- | ---------------------------------------------------- |
| Edge α += Δ            | ✅ 是    | 加法交换律，多个 Agent 同时 +1 结果相同              |
| Edge β += Δ            | ✅ 是    | 同上                                                 |
| Thompson Sampling 采样 | ❌ 否    | Agent 读到的后验取决于之前谁写了；这是多路分支的根源 |
| Rate Decay 0.5^n       | ❌ 否    | n 的计算依赖于 1 小时窗口内的写入顺序                |
| Canary 晋升/降级       | ❌ 否    | 阈值判断依赖于 success_count 的当前值                |
| Freeze Mode 触发       | ✅ 是    | 5 分钟窗口内 failure_rate 只依赖计数，不依赖顺序     |

**结论：** 写入侧（α/β 更新）具有因果不变性，读取侧（Gene 选择）天然是多路分支的。这是任何在线学习系统的固有性质，不是缺陷。

**超图带来的改进：** 将 Rate Decay 从"基于写入顺序的 0.5^n"改为"基于因果距离的衰减"——一个 capsule 的权重衰减不是按时间排名，而是按它在因果图中与当前查询点的距离。距离越远（因果链越长）→ 权重越低。这比纯时间衰减更精准。

### 3.5 规则空间：Gene 蒸馏的拓扑视角

**Wolfram 的规则空间（Rulial Space）：** 所有可能的重写规则构成一个空间，不同的规则之间可以定义距离。

**映射：** Gene 库 = 规则空间的一个有限采样。Gene 蒸馏 = 在规则空间中发现新的有效规则。

```
当前 Gene 蒸馏:
  收集成功 Capsule → LLM 提炼 → 新 Gene → Canary 验证

规则空间视角:
  成功 Capsule 在规则空间中定义了一个"高 fitness 区域"
  蒸馏 = 在该区域的邻域中搜索新规则
  Canary = 验证新规则是否确实在 fitness landscape 上
```

**超图增量：** MAP-Elites（§2.2.1）在行为描述符空间（behavior descriptor space）维护精英地图。如果把 Gene 库视为规则空间的离散采样，可以用超图的结构距离（两个 Gene 参与的超边模式的 Jaccard 距离）作为行为描述符，自动维护 Gene 多样性。

---

## 4. 计算复杂度分析

### 4.1 当前系统复杂度

| 操作                 | 复杂度   | 瓶颈                                |
| -------------------- | -------- | ----------------------------------- |
| `selectGene()`       | O(G · T) | G=候选 Gene 数, T=signalTags 维度数 |
| `recordOutcome()`    | O(1)     | 单条 edge upsert                    |
| `tagCoverageScore()` | O(T · M) | T=事件 tag 数, M=gene match 模式数  |
| Pooled Prior 聚合    | O(G)     | 一次 SQL GROUP BY                   |
| Bimodality Index     | O(W)     | W=窗口大小 (固定 20)                |
| 全局 API 调用        | O(1)     | 上述步骤串行，主要是网络延迟        |

**当前总复杂度：** O(G · T) per request，G < 100, T < 10 → 实质 O(1)

### 4.2 超图方案复杂度

| 操作                 | 复杂度   | 分析                                                          |
| -------------------- | -------- | ------------------------------------------------------------- |
| 超边写入             | O(K)     | K=超边元素数 (5-8)，需要索引 K 个原子                         |
| 超边模式匹配（查询） | O(C · P) | C=候选超边数, P=模式原子数。若有倒排索引：O(min_postings · P) |
| 因果图构建           | O(N)     | N=capsule 数，每个 capsule 追加 1-2 条因果边                  |
| 因果图遍历（归因）   | O(D)     | D=因果链深度，BFS/DFS                                         |
| 分枝距离计算         | O(H)     | H=两个 Agent 的历史长度，需对比选择序列                       |
| 规则空间邻域搜索     | O(G²)    | Gene 两两计算结构距离                                         |

**关键问题：超边模式匹配**

当前 `tagCoverageScore()` 实质上已经在做超边模式匹配——检查事件的 tag 集合是否是 Gene match 模式的超集。复杂度从 O(T · M) 变为 O(min_postings · P)，在有倒排索引时**更快**（因为 min_postings 通常远小于遍历所有 Gene）。

```
当前: 遍历所有 Gene，对每个检查 tagCoverageScore → O(G · T · M)

超图 + 倒排索引:
  1. 取事件的每个原子 → 查倒排索引 → 获取包含该原子的所有超边
  2. 交集 → 得到同时包含所有事件原子的超边
  3. 从结果超边中提取 gene 原子 → 候选

  复杂度: O(K · avg_postings) where K=事件原子数(5-8), avg_postings=每个原子的平均超边数
  当前数据规模: ~1000 超边, ~100 Gene → avg_postings ≈ 20
  → O(5 × 20) = O(100) vs 当前 O(100 × 4 × 3) = O(1200)
  → 超图方案实际更快
```

### 4.3 存储开销对比

| 数据                   | 当前                     | 超图方案                    | 增量                    |
| ---------------------- | ------------------------ | --------------------------- | ----------------------- |
| Edge 表                | 1 row per (signal, gene) | 不变（作为聚合视图）        | 0                       |
| Capsule 表             | 1 row per execution      | 不变 + 增加原子引用         | +30% 列宽               |
| **新增：因果链表**     | 不存在                   | 1 row per causal link       | +N rows（N=capsule 数） |
| **新增：原子倒排索引** | 不存在                   | 1 row per (atom, hyperedge) | +K×N rows               |
| **新增：分枝快照**     | 不存在                   | 可选，按需生成              | 可忽略                  |

**存储增长估算（1000 Agent, 100K Capsule/月）：**

- 因果链：~100K rows/月 × 60 bytes ≈ 6 MB/月
- 倒排索引：~100K × 7 atoms × 40 bytes ≈ 28 MB/月
- 总增量：~34 MB/月 → **完全可接受**

### 4.4 查询模式变化

```sql
-- 当前: "找到 error:500 相关的最佳 Gene"
SELECT gene_id, SUM(success_count)+1 AS alpha, SUM(failure_count)+1 AS beta
FROM im_evolution_edges
WHERE signal_type = 'error:500'
GROUP BY gene_id;

-- 超图: "找到 error:500 + openai + api_call 情景的最佳 Gene"（无需 signal_key 拼接）
SELECT e.gene_atom AS gene_id,
       SUM(CASE WHEN e.outcome_atom = 'success' THEN 1 ELSE 0 END) + 1 AS alpha,
       SUM(CASE WHEN e.outcome_atom = 'failed' THEN 1 ELSE 0 END) + 1 AS beta
FROM im_hyperedge_atoms e
WHERE e.atom_type = 'signal_type' AND e.atom_value = 'error:500'
  AND e.hyperedge_id IN (
    SELECT hyperedge_id FROM im_hyperedge_atoms
    WHERE atom_type = 'provider' AND atom_value = 'openai'
  )
  AND e.hyperedge_id IN (
    SELECT hyperedge_id FROM im_hyperedge_atoms
    WHERE atom_type = 'stage' AND atom_value = 'api_call'
  )
GROUP BY e.gene_atom;
```

**观察：** 超图查询更精确（不需要字符串拼接/解析），但 SQL 表达更冗长。实际实现应抽象为函数。

---

## 5. Schema 层面设计

### 5.1 渐进式改造（推荐）

不一次性替换现有 schema，而是**在现有表之上叠加超图层**：

```sql
-- ═══ 保留现有表不动 ═══
-- im_evolution_edges     ← 继续作为聚合缓存（读取热路径）
-- im_evolution_capsules  ← 继续作为事件流
-- im_genes               ← 继续作为 Gene 存储
-- im_gene_signals        ← 继续作为 Gene-Signal 关联

-- ═══ 新增超图层 ═══

-- 1. 原子注册表（去重的维度值）
CREATE TABLE im_atoms (
  id        BIGINT AUTO_INCREMENT PRIMARY KEY,
  kind      VARCHAR(20) NOT NULL,    -- 'signal_type'|'provider'|'stage'|'severity'|'gene'|'agent'|'context'|'outcome'
  value     VARCHAR(255) NOT NULL,
  UNIQUE INDEX idx_kind_value (kind, value)
);

-- 2. 超边（每条 = 一次 capsule 事件）
CREATE TABLE im_hyperedges (
  id          VARCHAR(30) PRIMARY KEY,  -- = capsule id
  type        VARCHAR(20) NOT NULL,     -- 'execution'|'distillation'|'fork'
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_type (type),
  INDEX idx_created (created_at)
);

-- 3. 超边-原子关联（倒排索引的基础）
CREATE TABLE im_hyperedge_atoms (
  hyperedge_id  VARCHAR(30) NOT NULL,
  atom_id       BIGINT NOT NULL,
  role          VARCHAR(20),            -- 可选：'cause'|'effect'|'participant'
  PRIMARY KEY (hyperedge_id, atom_id),
  INDEX idx_atom (atom_id, hyperedge_id)  -- 倒排索引方向
);

-- 4. 因果链（capsule 间的因果关系）
CREATE TABLE im_causal_links (
  cause_id    VARCHAR(30) NOT NULL,     -- 源 capsule/hyperedge id
  effect_id   VARCHAR(30) NOT NULL,     -- 目标 capsule/hyperedge id
  link_type   VARCHAR(20) NOT NULL,     -- 'learning'|'selection'|'distillation'
  strength    FLOAT DEFAULT 1.0,        -- 因果强度（0-1）
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (cause_id, effect_id),
  INDEX idx_effect (effect_id)
);
```

### 5.2 写入路径改造

```typescript
// 当前 recordOutcome() 流程:
//   1. 写 capsule → im_evolution_capsules
//   2. upsert edge → im_evolution_edges (α += Δ)
//   3. 检查 freeze / rate decay / canary

// 超图增强（在步骤 1 和 2 之间插入）:
async function recordOutcomeWithHypergraph(capsule: Capsule) {
  // 1. 写 capsule（不变）
  await writeCapsule(capsule);

  // 1.5 NEW: 注册原子 + 写超边
  const atoms = [
    { kind: 'agent', value: capsule.ownerAgentId },
    { kind: 'signal_type', value: capsule.signalType },
    ...capsule.signalTags.flatMap((tag) =>
      [
        tag.provider && { kind: 'provider', value: tag.provider },
        tag.stage && { kind: 'stage', value: tag.stage },
        tag.severity && { kind: 'severity', value: tag.severity },
      ].filter(Boolean),
    ),
    { kind: 'gene', value: capsule.geneId },
    { kind: 'outcome', value: capsule.outcome },
  ];
  const atomIds = await upsertAtoms(atoms);
  await writeHyperedge(capsule.id, 'execution', atomIds);

  // 1.6 NEW: 写因果链（这个 capsule 的 Gene 选择受哪些之前 capsule 的影响）
  const influencingEdge = await getEdge(capsule.signalKey, capsule.geneId);
  if (influencingEdge?.lastCapsuleId) {
    await writeCausalLink(influencingEdge.lastCapsuleId, capsule.id, 'learning');
  }

  // 2. upsert edge（不变，继续作为聚合缓存）
  await upsertEdge(capsule);

  // 3. freeze / decay / canary（不变）
  await postProcessing(capsule);
}
```

### 5.3 查询路径改造

```typescript
// 当前 selectGene(): tagCoverageScore() 遍历所有 Gene

// 超图增强: 先用倒排索引缩小候选集，再 Thompson Sampling
async function selectGeneWithHypergraph(signalTags: SignalTag[], agentId: string) {
  // Step 1: 从原子倒排索引获取候选 Gene（取代遍历全量）
  const signalAtoms = signalTags.flatMap((t) =>
    [
      { kind: 'signal_type', value: t.type },
      t.provider && { kind: 'provider', value: t.provider },
      t.stage && { kind: 'stage', value: t.stage },
    ].filter(Boolean),
  );

  // 查倒排索引: 哪些超边包含这些原子？从这些超边提取 gene 原子
  const candidateGeneIds = await queryHypergraphCandidates(signalAtoms);

  // Step 2: 对候选 Gene 计算 coverageScore + Thompson Sampling（不变）
  // 但候选集已经被倒排索引缩小了
  return thompsonSelect(candidateGeneIds, signalTags, agentId);
}
```

---

## 6. 影响评估

### 6.1 正面影响

| 领域                | 影响                                     | 价值                                   |
| ------------------- | ---------------------------------------- | -------------------------------------- |
| **Signal 维度保真** | 不再折叠到字符串，每个维度独立可查       | 消除 §3.4 的碎片化根因                 |
| **因果可追溯**      | 任何 edge 的 α/β 可归因到具体 capsule 链 | 反事实分析、phantom success 检测       |
| **查询精度提升**    | 倒排索引 → 精确的多维交集查询            | 候选集缩小 5-10x                       |
| **新增维度零成本**  | 加维度 = 加一种原子 kind，无 schema 变更 | 未来可加 region, model_version 等      |
| **分枝感知池化**    | Pooled Prior 可按策略相似度加权          | 更精准的跨 Agent 知识共享              |
| **可视化涌现**      | 因果图结构自然定义节点间距               | MAP-DESIGN 的 Louvain 可被因果聚类替代 |

### 6.2 负面影响与代价

| 代价           | 量级                                                     | 是否可接受                          |
| -------------- | -------------------------------------------------------- | ----------------------------------- |
| 存储增长       | +34 MB/月（100K capsule）                                | ✅ 完全可接受                       |
| 写入延迟增加   | +2-5ms per recordOutcome（原子注册 + 超边写入 + 因果链） | ✅ 可接受（当前总延迟 ~50ms）       |
| SQL 查询复杂度 | 超图查询需 2-3 个子查询 vs 当前单表 WHERE                | ⚠️ 需要倒排索引，否则 JOIN 爆炸     |
| 认知复杂度     | 团队需理解超图概念                                       | ⚠️ 中等——但超图只是"多列索引"的抽象 |
| 迁移成本       | 新增 4 张表 + 写入路径增强                               | ⚠️ ~5 天工作量                      |
| 因果图膨胀     | 长链可达数千节点                                         | ✅ 定期剪枝（>30 天的因果链压缩）   |

### 6.3 值不值得？分层判断

| 特性                             | 投入                                     | 回报                   | 判定                                |
| -------------------------------- | ---------------------------------------- | ---------------------- | ----------------------------------- |
| **超边存储（原子化维度）**       | 3 张新表 + 写入增强                      | 彻底解决 signal 折叠   | ✅ **值得（P1）**                   |
| **因果链追踪**                   | 1 张新表 + 写入 1 行/capsule             | 归因分析、反事实推演   | ✅ **值得（P1）**                   |
| **倒排索引加速查询**             | 利用 im_hyperedge_atoms 的 idx_atom 索引 | 候选集缩小、查询更精确 | ✅ **值得（随超边一起来）**         |
| **分枝距离感知池化**             | 需要计算 Agent 历史序列距离              | 更精准的 Pooled Prior  | ⚠️ **Phase 2（需先有因果图数据）**  |
| **因果距离衰减（替代时间衰减）** | 需要 BFS 遍历因果图                      | 比纯时间衰减更精准     | ⚠️ **Phase 2（计算开销需评估）**    |
| **规则空间多样性管理**           | Gene 两两距离矩阵 O(G²)                  | 自动 Gene 多样性维护   | ❌ **Phase 3（G < 100 时不急）**    |
| **完整多路系统**                 | 全量分支记录 + 合并策略                  | 理论完备性             | ❌ **不值得（太抽象，无直接收益）** |

---

## 7. 与现有设计的兼容性

### 7.1 不破坏的

- im_evolution_edges 继续作为聚合缓存的热路径——超图层是叠加的，不替换
- Thompson Sampling + Pooled Prior 逻辑完全不变
- SignalTag[] 架构不变——超图层的原子与 SignalTag 的维度一一对应
- Bimodality Index 不变——它在 edge 层面计算，超图层提供的是更精确的维度分解
- Rate Decay / Freeze / Canary 不变
- 前端 MAP-DESIGN 不变——但因果图可以提供更好的布局数据

### 7.2 替代的

| 现有组件                     | 超图替代           | 何时替代                              |
| ---------------------------- | ------------------ | ------------------------------------- |
| signal_key 字符串拼接        | 原子化维度查询     | Phase 1（但保留 signal_key 作为兼容） |
| tagCoverageScore() 全量遍历  | 倒排索引缩小候选集 | Phase 1                               |
| Pooled Prior 全局均等池化    | 分枝距离加权池化   | Phase 2                               |
| 时间衰减 0.5^(age/30d)       | 因果距离衰减       | Phase 2                               |
| Louvain 社区检测（MAP 布局） | 因果图聚类         | Phase 3                               |

---

## 8. 北极星指标：不度量就没有判断

> 问题前置：在讨论超图"是否有收益"之前，必须先定义"收益"是什么。当前系统没有统一的度量收口——散落在 API 返回值、SSE 事件、前端 stats bar 中，不入库，不可回溯。

### 8.1 北极星指标定义

| 指标                          | 公式                                         | 含义                                      | 采集时机                  | 粒度                        |
| ----------------------------- | -------------------------------------------- | ----------------------------------------- | ------------------------- | --------------------------- |
| **System Success Rate (SSR)** | `Σ success / Σ total` capsules in window     | 全局成功率——系统"有没有在帮 Agent 做对事" | 每次 recordOutcome        | 全局 / per-agent / per-mode |
| **Convergence Speed (CS)**    | 新 Agent 达到 SSR ≥ 0.7 所需的 capsule 数    | 冷启动效率——Pooled Prior 有没有用         | Agent 累计 capsule 达标时 | per-agent                   |
| **Routing Precision (RP)**    | `Σ(coverage_level ≥ 1 的 capsule) / Σ total` | 精细匹配比例——信号架构是否有效            | 每次 recordOutcome        | 全局 / per-mode             |
| **Regret Proxy (RegP)**       | `1 - (SSR_actual / SSR_oracle)`              | 次优选择损失（oracle = 事后最优 Gene）    | 定时离线计算（每小时）    | 全局 / per-mode             |
| **Gene Diversity (GD)**       | `1 - HHI(gene_usage_shares)`                 | 策略多样性——是否陷入单一 Gene             | 定时计算                  | 全局                        |
| **Exploration Rate (ER)**     | `exploring_edges / total_edges`              | 探索覆盖度                                | 实时（已有）              | 全局                        |

**Oracle 定义（RegP 计算用）：** 对每个 capsule 事后查"同一 signalType 下哪个 Gene 的历史 SSR 最高"，作为该步的 oracle 选择。如果实际选择的 Gene 不是 oracle Gene 且 outcome=failed，计 regret=1；否则 regret=0。这是一个**宽松上界**，不需要真正的反事实推理。

### 8.2 冷启动阶段是否评估？

**要评估，但不用同一套阈值。**

| 阶段       | 条件                 | 评估策略                                                                                                              |
| ---------- | -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **冷启动** | 全局 capsule < 100   | 只记录原始指标，不计算 RegP（没有 oracle 基线）。CS 指标无意义（没有"老 Agent"做对照）。关注 GD（是否在探索而非利用） |
| **成长期** | 100 ≤ capsule < 1000 | 开始计算 RegP。CS 开始有意义（有 ≥1 个达标 Agent 作为基线）。SSR 可比较不同 mode                                      |
| **成熟期** | capsule ≥ 1000       | 全指标可用。定时 Regret 计算有统计显著性                                                                              |

### 8.3 指标收口入库

**不散落在代码各处。统一写入一张指标快照表。**

```sql
CREATE TABLE im_evolution_metrics (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  ts          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),  -- 采集时间
  window      VARCHAR(10) NOT NULL DEFAULT '1h',                  -- '1h' | '24h' | '7d'
  mode        VARCHAR(20) NOT NULL DEFAULT 'standard',            -- 'standard' | 'hypergraph'
  scope       VARCHAR(30) NOT NULL DEFAULT 'global',              -- 'global' | agent_id

  -- 核心指标
  ssr         FLOAT,       -- System Success Rate
  cs          INT,         -- Convergence Speed (capsules to SSR≥0.7, null if not reached)
  rp          FLOAT,       -- Routing Precision
  regp        FLOAT,       -- Regret Proxy
  gd          FLOAT,       -- Gene Diversity (1 - HHI)
  er          FLOAT,       -- Exploration Rate

  -- 原始计数（用于事后重算）
  total_capsules    INT NOT NULL DEFAULT 0,
  success_capsules  INT NOT NULL DEFAULT 0,
  unique_genes_used INT NOT NULL DEFAULT 0,
  unique_agents     INT NOT NULL DEFAULT 0,

  INDEX idx_ts_mode (ts, mode),
  INDEX idx_scope (scope, ts),
  @@map("im_evolution_metrics")
);
```

**采集频率：**

- `window='1h'`: 每小时 cron 计算，写入 global + per-active-agent 行
- `window='24h'`: 每天计算
- `window='7d'`: 每周计算
- 实时指标（SSR, ER）在 recordOutcome 时增量更新到内存计数器，每 5 分钟 flush 到 DB

---

## 9. 模式开关：控制变量实验

### 9.1 设计原则

> 不搞两套系统、不搞两套表。一套数据 + 一个 `mode` 标签。

超图改造的价值必须通过 A/B 实验验证。但进化系统不是 Web 页面——不能简单地 50/50 分流。需要考虑：

1. **同一个 Agent 不能在两个 mode 之间切换**（否则学习历史互相污染）
2. **全局 Pooled Prior 需要按 mode 隔离**（否则 A 模式的经验泄漏到 B 模式）
3. **Gene 库是共享的**（两个 mode 用同一批 Gene，只是选择算法不同）

### 9.2 模式定义

```typescript
type EvolutionMode = 'standard' | 'hypergraph';

// 决定方式（优先级从高到低）：
// 1. Agent 注册时指定 metadata.evolution_mode（显式）
// 2. 环境变量 EVOLUTION_DEFAULT_MODE（全局默认）
// 3. 默认 'standard'

function getAgentMode(agentId: string): EvolutionMode {
  const agent = await getAgentCard(agentId);
  const explicit = agent?.metadata?.evolution_mode;
  if (explicit === 'hypergraph' || explicit === 'standard') return explicit;
  return (process.env.EVOLUTION_DEFAULT_MODE as EvolutionMode) || 'standard';
}
```

### 9.3 分流策略

| 策略                | 做法                                                   | 适用阶段                  |
| ------------------- | ------------------------------------------------------ | ------------------------- |
| **全量 standard**   | 所有 Agent 用 standard mode                            | 当前（baseline 数据积累） |
| **固定分组**        | 注册时按 agentId hash % 10 分配 mode（10% hypergraph） | 冷启动实验                |
| **手动 opt-in**     | Agent 注册时 `metadata.evolution_mode = 'hypergraph'`  | 定向测试                  |
| **全量 hypergraph** | 所有 Agent 切换                                        | 实验验证后                |

### 9.4 数据隔离：标签而非分表

**Capsule 和 Edge 加 `mode` 字段，不新建表。**

```
im_evolution_capsules:  + mode VARCHAR(20) DEFAULT 'standard'
im_evolution_edges:     + mode VARCHAR(20) DEFAULT 'standard'
```

**Pooled Prior 隔离：** 全局聚合 SQL 加 `WHERE mode = ?`

```sql
-- standard mode 的全局先验（只聚合 standard capsules 产生的 edges）
SELECT gene_id, SUM(success_count)+1, SUM(failure_count)+1
FROM im_evolution_edges
WHERE signal_type = ? AND mode = 'standard'
GROUP BY gene_id;

-- hypergraph mode 的全局先验
SELECT gene_id, SUM(success_count)+1, SUM(failure_count)+1
FROM im_evolution_edges
WHERE signal_type = ? AND mode = 'hypergraph'
GROUP BY gene_id;
```

**Gene 库不隔离**——两个 mode 共享同一批 Gene。差异只在选择算法和学习路径。

### 9.5 Metrics 按 mode 对比

```sql
-- 两个 mode 的 SSR 对比（过去 24h）
SELECT mode,
       COUNT(*) as total,
       SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) as success,
       SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) / COUNT(*) as ssr
FROM im_evolution_capsules
WHERE created_at > NOW() - INTERVAL 24 HOUR
GROUP BY mode;
```

当两个 mode 各自积累 ≥200 capsule 后，可以做 Fisher exact test 或 chi-squared test 判断 SSR 差异是否显著。

---

## 10. Schema 统一改造

### 10.1 现有表增量（mode 标签）

```sql
-- Capsule 加 mode
ALTER TABLE im_evolution_capsules
  ADD COLUMN mode VARCHAR(20) NOT NULL DEFAULT 'standard',
  ADD INDEX idx_mode (mode);

-- Edge 加 mode
ALTER TABLE im_evolution_edges
  ADD COLUMN mode VARCHAR(20) NOT NULL DEFAULT 'standard';
-- 注意：unique index 需要重建，加入 mode
-- 原: @@unique([ownerAgentId, signalKey, geneId])
-- 新: @@unique([ownerAgentId, signalKey, geneId, mode])
```

### 10.2 超图层表（仅 hypergraph mode 写入）

保留 §5.1 的四张表（im_atoms, im_hyperedges, im_hyperedge_atoms, im_causal_links），但加一个约束：

```typescript
// 只有 hypergraph mode 才写超图层
if (agentMode === 'hypergraph') {
  await writeHyperedge(capsuleId, signalTags, geneId, agentId);
  await writeCausalLink(previousCapsuleId, capsuleId);
}
// standard mode 跳过——零额外开销
```

### 10.3 指标表（两个 mode 共用）

§8.3 的 `im_evolution_metrics` 表，`mode` 列区分。每次采集生成两行（standard + hypergraph 各一行）。

### 10.4 Prisma schema 改动汇总

```prisma
// im_evolution_capsules — 增加 mode
model IMEvolutionCapsule {
  // ... 现有字段 ...
  mode            String    @default("standard")  // 'standard' | 'hypergraph'
  @@index([mode])
}

// im_evolution_edges — 增加 mode，unique key 扩展
model IMEvolutionEdge {
  // ... 现有字段 ...
  mode            String    @default("standard")
  @@unique([ownerAgentId, signalKey, geneId, mode])  // 替换原 @@unique
}

// 新增：指标快照
model IMEvolutionMetrics {
  id                Int       @id @default(autoincrement())
  ts                DateTime  @default(now())
  window            String    @default("1h")
  mode              String    @default("standard")
  scope             String    @default("global")
  ssr               Float?
  cs                Int?
  rp                Float?
  regp              Float?
  gd                Float?
  er                Float?
  totalCapsules     Int       @default(0)
  successCapsules   Int       @default(0)
  uniqueGenesUsed   Int       @default(0)
  uniqueAgents      Int       @default(0)
  @@index([ts, mode])
  @@index([scope, ts])
  @@map("im_evolution_metrics")
}
```

---

## 11. 结论

### 11.1 修正后的结论

原 §8 的结论（"超图带来因果追踪和维度保真"）在理论上成立，但**缺少验证基础**——我们没有北极星指标，无法判断"带来"了什么。

修正后的路径：

```
Phase 0（前置条件，~3 天）: ← 新增，必须先做
  - 定义并实现北极星指标（SSR, CS, RP, RegP, GD, ER）
  - im_evolution_metrics 指标表 + 采集逻辑
  - Capsule/Edge 加 mode 标签
  - Pooled Prior 按 mode 隔离查询
  - 标准模式积累 baseline 数据

Phase 1（超图实验，~5 天）: ← 原 Phase 1，但现在有对照
  - 原子表 + 超边表 + 倒排索引 + 因果链
  - 仅 hypergraph mode 写入超图层
  - 对比两个 mode 的 6 项北极星指标

Phase 2（评估决策点）:
  - 积累 ≥200 capsules/mode 后做统计显著性检验
  - 如果 hypergraph SSR > standard SSR 且 p < 0.05 → 扩大比例
  - 如果无显著差异 → 保留因果链（低成本），关闭原子化超边（高成本低收益）
  - 如果 hypergraph 更差 → 全量切回 standard，超图层只读归档
```

### 11.2 不做什么

- **不做** 完整多路系统——理论优美但无实用收益
- **不做** 规则空间连续化——需要向量 DB，违反约束
- **不做** 在没有 baseline 指标的情况下上超图——先度量，再改造
- **不做** 两套数据表——一套表 + mode 标签，零维护成本

---

_Last updated: 2026-03-18_
