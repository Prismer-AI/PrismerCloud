<p align="center">
  <a href="../HYPERGRAPH-THEORY.md"><img alt="English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./HYPERGRAPH-THEORY.md"><img alt="简体中文" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../de/HYPERGRAPH-THEORY.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../fr/HYPERGRAPH-THEORY.md"><img alt="Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../es/HYPERGRAPH-THEORY.md"><img alt="Español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
  <a href="../ja/HYPERGRAPH-THEORY.md"><img alt="日本語" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
</p>

# 超图进化理论 (Hypergraph Evolution Theory)

> Prismer 如何将智能体学习建模为 N 元知识结构——
> 灵感来自 Wolfram 物理学和因果集合理论。

---

## 二元边 (Pairwise Edges) 的局限

传统的智能体学习系统将知识建模为**二元边 (2-ary edges)**：`(信号, 基因)` 对，附带成功/失败计数。

```
Standard model:
  edge("error:500|openai|api_call", "Gene_X") → { success: 12, failure: 3 }
```

这种方式在一定范围内有效——直到它失效。信号键 (signal key) 是一个**折叠字符串 (collapsed string)**，将多个维度压缩为一个。考虑以下场景：

```
Real event:
  Agent A encounters error:500 from OpenAI during api_call stage,
  applies Gene_X (500 Error Triage), outcome: success.

Stored as:
  signal_key = "error:500|openai|api_call"
  gene_id    = "Gene_X"
```

现在 Agent B 在 `parsing` 阶段遇到来自 OpenAI 的 `error:500`。标准模型看到的是一个完全不同的信号键——`"error:500|openai|parsing"`——并返回零匹配。但实际上 `Gene_X` 在这里很可能同样适用，因为真正重要的是 `error:500 + openai` 的组合，而非阶段 (stage)。

**二元模型通过将维度折叠为字符串，破坏了维度之间的关系。**

---

## 超图 (Hypergraph)：保留完整上下文

[超图 (Hypergraph)](https://en.wikipedia.org/wiki/Hypergraph) 是图的推广形式，允许边连接**任意数量的节点**（而非仅 2 个）。在 Prismer 的进化引擎中，我们使用超图将智能体执行事件建模为 N 元关系 (N-ary relations)。

### 核心组件

#### 原子 (Atoms) — 归一化维度

执行事件的每个维度都作为独立的**原子 (atom)** 存储：

| 类型 (Kind) | 示例 | 捕获的内容 |
|------|----------|-----------------|
| `signal_type` | `error:500`, `error:timeout`, `perf:high_latency` | 错误或性能信号 |
| `provider` | `openai`, `exa`, `anthropic` | 涉及的外部服务 |
| `stage` | `api_call`, `network_request`, `parsing` | 执行阶段 |
| `severity` | `transient`, `critical`, `degraded` | 错误严重程度 |
| `gene` | `seed_timeout_retry_v1`, `500_Error_Triage` | 应用的策略 |
| `agent` | `agent_alice`, `agent_bob` | 执行智能体 |
| `outcome` | `success`, `failed` | 执行结果 |

原子按 **(kind, value) 唯一**——相同的原子节点在所有共享它的超边 (hyperedges) 中被复用。

#### 超边 (Hyperedges) — N 元执行事件

单条超边捕获一次胶囊 (capsule) 执行的**完整上下文**：

```
Hyperedge #cap_001 connects 7 atoms:
  ┌─ signal_type: "error:500"
  ├─ provider: "openai"
  ├─ stage: "api_call"
  ├─ severity: "transient"
  ├─ gene: "500_Error_Triage"
  ├─ agent: "agent_alice"
  └─ outcome: "success"
```

这是一个**单一的 7 元关系 (7-ary relation)**，而非 7 条独立的边。这种区别对查询至关重要。

#### 因果链接 (Causal Links) — 学习链

当 Agent B 因为 Agent A 的结果更新了后验概率 (posterior) 而选择某个基因时，我们记录一条显式的**因果链接 (causal link)**：

```
Capsule_A (alice, Gene_X, success)
    │
    │  learning link (strength: 1.0)
    │  "A's success updated Gene_X's Beta posterior,
    │   which influenced B's Thompson Sampling draw"
    ▼
Capsule_B (bob, Gene_X, success)
```

因果链接在标准模型中是**不可见的**——你无法追溯智能体为何选择了某个特定基因。有了超图，你可以重建完整的影响链。

---

## 查询：基于原子的集合交集

超图的核心优势在于查询时的**维度分解 (dimensional decomposition)**。

### 标准模式（字符串匹配）

```
Query: "error:500|openai|parsing"
Result: No match (exact string differs from "error:500|openai|api_call")
```

### 超图模式（原子交集）

```
Query atoms: {signal_type: "error:500", provider: "openai", stage: "parsing"}

Step 1: Find all hyperedges containing atom "error:500" → {cap_001, cap_007, cap_012}
Step 2: Find all hyperedges containing atom "openai"    → {cap_001, cap_003, cap_007}
Step 3: Intersection: {cap_001, cap_007}
Step 4: Extract gene atoms from matched hyperedges → {"500_Error_Triage", "API_Retry_Backoff"}
Step 5: These are candidates for Thompson Sampling selection
```

查询匹配了 `cap_001`，尽管 `stage` 不同——因为它与查询原子共享了 3 个中的 2 个。这是基于结构重叠的**软匹配 (soft matching)**，而非精确字符串相等。

### 性能

倒排索引 (inverted index)（`原子 → 超边`）使查询高效：

| 基因数量 | 标准模式 | 超图模式 |
|-----------|--------------|-----------------|
| 50（当前） | O(G x T) 全表扫描 | O(postings) 倒排索引 |
| 1,000 | 需要 LIMIT + ORDER BY | 同样的倒排索引 |
| 10,000 | 需要物化视图 (materialized views) | 原子基数保持有界 |

原子基数以对数方式增长（唯一的错误类型、提供商和阶段数量是有限的），而基因数量线性增长。超图的扩展性更优。

---

## 双峰性检测 (Bimodality Detection)

超图启用了一种在标准模型中不可能实现的检测机制：**双峰性指数 (bimodality index)**。

### 隐藏的上下文问题

```
Gene_X overall success rate: 50%  (looks mediocre)

Actually:
  When provider=openai:  90% success  (Gene_X is excellent here)
  When provider=anthropic: 10% success (Gene_X is terrible here)
```

二元模型看到 50% 就继续前进了。超图则发现结果按 `provider` 原子聚类，并将其标记为**双峰 (bimodal)**。

### 算法：过度离散检测 (Overdispersion Detection)

```
1. Compute global success rate p from recent outcomes
2. Split outcomes into time windows of size W
3. Compute success rate per window → [r₁, r₂, ..., rₖ]
4. Compute cross-window variance: Var(rᵢ)
5. Compute expected variance if i.i.d.: p(1-p)/W
6. Overdispersion ratio = Var(rᵢ) / expected_var
7. Bimodality index = clamp((ratio - 1) / 9, 0, 1)
```

| 指数 | 解读 | 操作建议 |
|-------|---------------|--------|
| 0.0 | 同质结果 (Homogeneous outcomes) | 标准汤普森采样 (Thompson Sampling) 即可 |
| 0.3 | 轻度异质性 (Mild heterogeneity) | 监控，可能受益于上下文拆分 |
| 0.7 | 强双峰性 (Strong bimodality) | 信号可能需要维度分解 |
| 1.0 | 极端双峰性 (Extreme bimodality) | 建议使用超图原子级分析 |

当检测到双峰性时，系统可以将信号分解为原子级子信号，并按上下文选择基因——这是仅在超图模式下才存在的能力。

---

## 北极星指标 (North Star Metrics)

六个定量指标用于评估进化引擎性能，分别为标准模式和超图模式独立计算：

| 指标 | 符号 | 公式 | 衡量内容 |
|--------|--------|---------|----------|
| **系统成功率** | SSR | `success / total capsules` | 整体有效性 |
| **收敛速度** | CS | 新智能体达到 SSR >= 0.7 所需胶囊数 | 冷启动效率 |
| **路由精度** | RP | `capsules with coverage ≥ 1 / total` | 信号-基因匹配质量 |
| **遗憾代理** | RegP | `1 - (SSR_actual / SSR_oracle)` | 次优选择的机会成本 |
| **基因多样性** | GD | `1 - HHI(gene usage shares)` | 避免单一文化 (monoculture) |
| **探索率** | ER | `edges with < 10 executions / total edges` | 探索与利用的平衡 |

### A/B 对比

两种模式并行积累指标。当两者均拥有 >= 200 个胶囊时：

```
If hypergraph.SSR - standard.SSR > 0.05  →  hypergraph is better
If delta < -0.05                          →  standard is better
Otherwise                                 →  no significant difference
```

0.05 的阈值较为保守——我们希望在切换模式之前获得充分的证据。

---

## 与 Wolfram 物理学的关联

超图模型的灵感来自 [Wolfram 物理学 (Wolfram Physics)](https://www.wolframphysics.org/)，该理论提出宇宙是一个通过重写规则 (rewrite rules) 演化的超图。映射关系如下：

| Wolfram 概念 | 进化引擎对应物 |
|----------------|----------------------|
| **原子** (Atoms)（离散标记） | 信号维度、基因、智能体——进化的词汇表 |
| **超边** (Hyperedges)（N 元关系） | 胶囊执行——保留完整上下文 |
| **重写规则** (Rewrite rules)（状态转换） | 基因策略执行——将错误状态转换为已解决状态 |
| **因果图** (Causal graph)（可达性） | 学习链——哪些胶囊影响了哪些决策 |
| **多路系统** (Multiway system)（并行分支） | 不同智能体同时尝试不同策略 |
| **分支空间** (Branchial space)（分支距离） | 智能体策略相似度——两个智能体的方法有多接近 |

### 未来可能性

- **因果归因 (Causal attribution)**："该基因的成功率提高了，因为 Agent A 的 3 次成功胶囊通过 2 条因果链接传播，影响了 Agent B 的选择"
- **策略相似度 (Strategy similarity)**：在分支空间中测量智能体之间的距离，以发现自然聚类
- **结构性基因相似度 (Structural gene similarity)**：与相同原子模式共现的两个基因可能是可互换的
- **MAP-Elites 多样性**：确保基因池覆盖完整的原子空间，而非仅集中在高流量区域

---

## 数据模型

```
┌──────────┐       ┌───────────────────┐       ┌──────────┐
│  IMAtom  │◄──────│  IMHyperedgeAtom  │──────►│IMHyperedge│
│          │       │  (inverted index) │       │          │
│  id      │       │                   │       │  id      │
│  kind    │       │  atomId           │       │  type    │
│  value   │       │  hyperedgeId      │       │  created │
│          │       │  role             │       │          │
└──────────┘       └───────────────────┘       └──────┬───┘
                                                      │
                                               ┌──────┴───────┐
                                               │IMCausalLink   │
                                               │               │
                                               │  causeId  ────┤ (hyperedge)
                                               │  effectId ────┤ (hyperedge)
                                               │  linkType     │
                                               │  strength     │
                                               └───────────────┘
```

### 预期表规模

| 表 | 增长模式 | 在 10K 胶囊时 |
|-------|---------------|-----------------|
| `im_atoms` | 对数增长（有界词汇表） | 约 500 行 |
| `im_hyperedges` | 线性增长（每个胶囊 1 条） | 10,000 行 |
| `im_hyperedge_atoms` | 线性增长 x 扇出（每条边约 7 个） | 70,000 行 |
| `im_causal_links` | 亚线性增长（并非所有胶囊都有链接） | 约 3,000 行 |

倒排索引是最大的表，但在数百万胶囊规模下仍完全在单机 MySQL 容量范围内。

---

## 实现状态

| 阶段 | 范围 | 状态 |
|-------|-------|--------|
| **阶段 0** | 北极星指标 + mode 列 + 数据隔离 | 已完成 |
| **阶段 1** | 原子/超边/因果链接写入 + 倒排索引查询 + 双峰性检测 | 已完成（功能开关控制） |
| **阶段 2** | 在每种模式 >= 200 个胶囊时进行 A/B 评估 + 模式扩展决策 | 等待数据 |
| **阶段 3** | 分支距离 + 因果衰减 + MAP-Elites + 基因相似度 | 已规划 |

超图层是**增量式的 (additive)**——它写入新表，而不修改现有的边/胶囊逻辑。两种模式并行运行，通过共享表中的 `mode` 列实现隔离。

---

## 延伸阅读

- [Wolfram 物理项目 (Wolfram Physics Project)](https://www.wolframphysics.org/) — 理论基础
- [伯努利赌博机的汤普森采样 (Thompson Sampling for Bernoulli Bandits)](https://arxiv.org/abs/1707.02038) — 选择算法
- [层次贝叶斯模型 (Hierarchical Bayesian Models)](https://en.wikipedia.org/wiki/Bayesian_hierarchical_modeling) — 冷启动的池化先验
- [赫芬达尔-赫希曼指数 (Herfindahl-Hirschman Index)](https://en.wikipedia.org/wiki/Herfindahl%E2%80%93Hirschman_index) — 基因多样性度量
- [MAP-Elites](https://arxiv.org/abs/1504.04909) — 质量-多样性优化（阶段 3）

---

<p align="center">
  <sub><a href="https://github.com/Prismer-AI/PrismerCloud">Prismer Cloud</a> 进化引擎的一部分</sub>
</p>
