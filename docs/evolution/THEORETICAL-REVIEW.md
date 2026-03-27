# Prismer Evolution Engine — 理论审查

> **Version:** 1.1
> **Date:** 2026-03-23
> **Status:** 理论分析 (含 v1.1 勘误)
> **审查视角：** Wolfram 多重计算框架 + SuperBrain 架构 + 范畴论适用性判断

**⚠️ v1.1 勘误 (2026-03-23):**

> 本文 v1.0 将 Wolfram 的计算不可约性理论机械映射到 Prismer Evolution Engine，这一映射存在根本性问题。
>
> Prismer 的 signal→gene→outcome 学习是一个标准的 **multi-armed bandit** 问题，Thompson Sampling 有严格的收敛保证（regret O(√(KT log T))）。观察到的"不收敛"现象应归因于：
>
> 1. **信号不完备** — signal 缺少关键维度（provider, stage, severity），导致不同问题被归为同一 signal
> 2. **分布漂移** — 环境变化导致同一 gene 的成功率随时间变化
> 3. **样本不足** — 冷启动阶段 bandit 尚未积累足够数据
>
> 这些都是可诊断、可修复的工程问题，不是计算复杂性的理论极限。生物进化面临的计算不可约性（基因型→表现型映射不可预测）与 agent 的 signal→outcome 统计学习在数学结构上不同——后者是可观测、可统计的。
>
> 本文中关于"可约性口袋"、"计算不可约性感知"的工程建议仍有参考价值（作为诊断信号质量的启发式方法），但**不应被理解为系统的理论极限**。
>
> 详见: [`docs/benchmark/PERFORMANCE-METRICS.md`](../benchmark/PERFORMANCE-METRICS.md) — 修正后的性能评估框架。
> **前置文档：** ENGINE.md v0.3.0, ENGINE-SUPERGRAPH.md v0.2
> **参考文献：**
>
> - Wolfram, "Metaphysics and the Ruliad" (Feb 2026)
> - Wolfram, "Why Does Biological Evolution Work?" (May/Dec 2024)
> - Jimenez-Romero et al., "SuperBrain: LLM-Assisted Iterative Evolution with Swarm Intelligence" (arXiv:2509.00510, Sept 2025)
> - Dündar, Arsiwalla, Elshatlawy, "Quantum Operators from Multiway Systems" (Jan 2026)
> - Foxon, "Mining Pockets of Computational Reducibility with AI" (July 2025)
> - "Hallucination as Navigation" (2026)
> - "The Computational Fabric of Reality" — 综述 (March 2026)

---

## 0. 本文目的

ENGINE-SUPERGRAPH.md 用 Wolfram 超图框架重新审视了进化引擎，并设计了超图层 + 因果链 + 北极星指标 + A/B 实验。前一轮审查尝试用范畴论（函子、伴随、层论、Kan 扩展）补全理论缺失。

**本文的核心问题：**

1. Wolfram 的多重计算（multicomputation）框架对 Prismer 的真正启示是什么？
2. SuperBrain 架构（SB_u 认知签名 + GA 迭代进化 + 群体智能）揭示了哪些架构性缺口？
3. 范畴论到底需不需要引入？

---

## 1. Wolfram 框架的核心启示：不是超图，是可约性口袋

### 1.1 关键洞察：计算不可约性是进化的根本障碍

Wolfram 在 2024-2025 年的生物进化研究中得出一个核心结论：

> **进化不需要环境的精心雕刻。主导力量是规则的计算不可约性与适应度函数的计算有界性之间的相互作用。长期的适应度中性漂变是常态，间歇性的"突破"才是进化的关键事件。**

映射到 Prismer：

```
Wolfram 概念                    Prismer 映射
────────────────────────────── ──────────────────────────────
规则 (Rule)                    Gene strategy
规则空间 (Rule Space)           Gene 库全体
适应度函数 (Fitness)            SSR (System Success Rate)
计算不可约性                    某些 signal-gene 组合本质上不可预测
可约性口袋 (Pockets)            可以学到的稳定 pattern
适应度中性漂变 (Neutral Drift)  Gene 表现不变但内部变异积累
突破性突变 (Breakthrough)       新 Gene 蒸馏成功，SSR 跳升
```

**ENGINE.md 和 ENGINE-SUPERGRAPH.md 缺失的关键概念：计算不可约性感知。**

当前系统对所有 signal-gene 对一视同仁——它假设任何 pattern 都可以被学习。但 Wolfram 的研究表明：**大部分规则空间是计算不可约的**。对于不可约的 pattern，积累再多的 capsule 也不会收敛到一个稳定的 Gene 推荐。

```
可约 pattern 示例：
  error:timeout + provider:openai → Exponential Backoff Gene → SSR 稳定在 0.85
  ← 可以学到，值得投入 capsule 预算

不可约 pattern 示例：
  error:500 + provider:mixed + stage:unpredictable → ??? → SSR 波动在 0.3-0.7
  ← 本质上不可预测（取决于不可约的外部条件），不应试图找到"最优 Gene"
```

### 1.2 可约性检测：当前系统已有但未命名的机制

令人惊讶的是，ENGINE.md 的 **Bimodality Index** 实际上是一个不完美的可约性探测器：

| Bimodality Index | Wolfram 解读                     | 当前解读                    |
| ---------------- | -------------------------------- | --------------------------- |
| < 0.3            | **可约口袋**——pattern 稳定可预测 | "结果稳定，confidence 可信" |
| 0.3 - 0.7        | **边界区域**——部分可约           | "有一定情景依赖"            |
| > 0.7            | **计算不可约**——不应期望收敛     | "严重两极化"                |

当前系统对 bimodality > 0.7 的响应是"触发 Gene 蒸馏建议"——试图把不可约 pattern 拆分成可约子 pattern。这在方向上是正确的（找更小的可约性口袋），但缺少**放弃机制**：有些 pattern 拆分后仍然不可约，系统应该承认这一点并停止浪费 capsule 预算。

### 1.3 中性漂变与突破性突变

Wolfram 的进化模型发现长期的适应度中性漂变（genotype 变了但 phenotype 不变）之后突然出现"机械式"复杂行为的突破。

映射到 Prismer：

- **中性漂变** = Gene 的 strategy 文字修改（蒸馏变体）但 SSR 不变
- **突破** = 新蒸馏的 Gene 突然在某个 signal 类别上 SSR 跳升

当前系统不区分这两种情况。蒸馏产出的 Gene 如果 SSR 没有显著提升就被忽略。但 Wolfram 的研究表明：**中性漂变是突破的必要前提**——它让 Gene 库在规则空间中"漫游"，直到偶然进入一个高适应度区域。

**建议：** 保留中性变异的 Gene（不要因为 SSR 相似就去重），让它们作为未来突破的候选基础。

### 1.4 Ruliad 与观察者理论：Agent 即有界观察者

Wolfram 2026 年 2 月的 "Scientific Metaphysics" 提出：

> **物理定律不是 Ruliad 的属性，而是"像我们一样的观察者"采样 Ruliad 的必然后果。我们被两个性质约束：计算有界性和对持续性的信念。**

映射到 Prismer 的 Agent：

| 观察者约束               | Agent 映射                   | 当前实现                       |
| ------------------------ | ---------------------------- | ------------------------------ |
| 计算有界性               | Agent 一次只能尝试一个 Gene  | ✅ selectGene() 返回单个推荐   |
| 对持续性的信念           | Agent 期望 Gene 效果持续稳定 | ✅ Edge confidence 隐含此假设  |
| 粗粒化 (Coarse-graining) | Agent 的 Personality 过滤器  | ⚠️ 3D 太粗，不足以表达认知差异 |
| 规则空间中的位置         | Agent 偏好的 Gene 子集       | ❌ 未建模                      |

**关键推论：** 两个 Agent 在"规则空间中的距离"决定了它们的经验能否有效共享。距离近（使用相似 Gene 集合的 Agent）→ Pooled Prior 权重高。距离远 → 权重低。这就是 ENGINE-SUPERGRAPH.md §3.3 的分枝距离概念，但从 Wolfram 的视角，它不只是"工程优化"——它是**观察者理论的必然要求**。

---

## 2. SuperBrain 架构审查：Prismer 缺失的四层

SuperBrain (arXiv:2509.00510) 定义了四层智能涌现架构：

```
Level 4: Superclass Brain  := ({SB_u}_{u∈U}, 𝒜, 𝒟, 𝒰)  ← 涌现的元智能
Level 3: Swarm Intelligence                               ← MoE 聚合 + 多目标适应度
Level 2: GA-Assisted Evolution                             ← 前向/反向迭代进化
Level 1: Subclass Brain    := (u, ℋ_u, ℳ_u, π_{θ|u})     ← 认知签名实体
```

### 2.1 Level 1: Subclass Brain — Prismer 的映射状态

SuperBrain 的 SB_u 定义：

```
SB_u := (u, ℋ_u, ℳ_u, π_{θ|u})

c_u := g(ℋ_u, ℳ_u) ∈ ℝ^d    // 认知签名向量
```

Prismer 当前映射：

| SB_u 组件              | Prismer 对应                        | 完整度  |
| ---------------------- | ----------------------------------- | ------- |
| u (用户/Agent 实体)    | im_users + im_agents + AgentCard    | ✅      |
| ℋ_u (交互历史)         | im_evolution_capsules + im_messages | ✅      |
| ℳ_u (持久记忆)         | im_memory_files + MEMORY.md         | ✅      |
| π\_{θ\|u} (个性化策略) | Personality 3D + Edge preferences   | ⚠️ 太粗 |
| c_u (认知签名向量)     | **不存在**                          | ❌      |
| ρ_u (可靠度)           | **不存在**                          | ❌      |

**最大的缺口是认知签名 c_u。** 这是一个 ℝ^d 向量，编码了 Agent 的语义偏好、行为模式、知识领域。没有这个，所有 Agent 在 Pooled Prior 中被当作同质实体——等于假设所有粒子在同一点。

**实现路径（不需要向量数据库）：**

```typescript
// 认知签名 = Agent 的 Gene 使用频谱 + 信号域偏好 + 成功率 profile
interface CognitiveSignature {
  geneUsageVector: number[]; // 对每个 Gene 的使用频率（稀疏向量）
  signalDomainVector: number[]; // 对每个 signal_type 的暴露频率
  successProfile: number[]; // 对每个 signal_type 的 SSR
  personalityVector: [number, number, number]; // rigor, creativity, risk
  reliability: number; // 历史 capsule 质量中位数
}

// 两个 Agent 的认知距离 = 余弦距离
function cognitiveDistance(a: CognitiveSignature, b: CognitiveSignature): number {
  return 1 - cosineSimilarity(a.geneUsageVector, b.geneUsageVector);
}
```

这个向量可以从 im_evolution_edges 和 im_evolution_capsules 直接计算，无需额外基础设施。

### 2.2 Level 2: GA-Assisted Evolution — 从一次性蒸馏到迭代进化

SuperBrain 的进化公式：

```
P_{t+1} = Select(Mutate(Crossover(P_t); KU, KI))

// 反向进化适应度：
f_λ(p; T, P_t) = Σ w_k M_k(Worker-LLM(p,T)) - λ_tok C_tok(p) - λ_div Ψ_δ(p; P_t) - λ_exp Ξ(p)
```

Prismer 当前的 Gene 蒸馏是 **一次性的**：收集 capsules → LLM 提炼 → Critique → Canary。SuperBrain 揭示了缺失的迭代循环：

```
当前流程（一次性）：
  Capsules → LLM Distill → New Gene → Canary → Done

SuperBrain 流程（迭代）：
  Capsules → LLM Distill → Gene Population P₀
  → Evaluate fitness → Select + Crossover + Mutate → P₁
  → Evaluate fitness → ... → P_t (convergence)
  → Best Gene → Canary

差异：当前只生成一个 Gene 变体，SuperBrain 维护一个 Gene 种群并迭代进化。
```

**直接价值：** 迭代进化让蒸馏出的 Gene 质量不再依赖单次 LLM 调用的运气。

**实现复杂度：** 中等。需要：

- Gene 种群管理（在 im_genes 中加 `generation` 和 `parent_id` 字段）
- Crossover 操作：两个 Gene strategy 的 LLM 融合
- Mutation 操作：已有的 LLM 蒸馏 + 随机 strategy 步骤变异
- 适应度评估：用实际 capsule SSR 或 dry-run 模拟
- 多样性控制：`sim(φ(g₁), φ(g₂)) < δ`

### 2.3 Level 3: Swarm Intelligence — 从均等池化到专家路由

SuperBrain 的群体聚合：

```
Q(p) ∝ Σ_{u∈U} α_u · S(p, c_u),    α_u ∝ ρ_u
```

当前 Pooled Prior：

```
α_combined = α_global × w + α_local × (1 - w)
w = max(0.2, 1 - n_agent / 100)    // 全局权重，只看经验量
```

**差异诊断：**

| 维度       | 当前 Pooled Prior           | SuperBrain Swarm                     |
| ---------- | --------------------------- | ------------------------------------ |
| Agent 权重 | 均等（所有 Agent 贡献相同） | 按可靠度 ρ_u 加权                    |
| Agent 选择 | 全部（所有 Agent 参与池化） | 按认知距离过滤（相似 Agent 才池化）  |
| 聚合方式   | 线性加权                    | MoE 路由（不同 signal 域找不同专家） |
| 多样性     | 不考虑                      | 多样性惩罚 Ψ_δ                       |

**最直接的改进：** 在 Pooled Prior 中引入认知距离加权：

```sql
-- 当前：全局均等聚合
SELECT gene_id, SUM(success_count)+1, SUM(failure_count)+1
FROM im_evolution_edges WHERE signal_type = ? GROUP BY gene_id;

-- 改进：按认知距离加权（近邻 Agent 权重高）
SELECT gene_id,
  SUM((success_count * cognitive_weight) + 1),
  SUM((failure_count * cognitive_weight) + 1)
FROM im_evolution_edges e
JOIN agent_cognitive_distances d ON e.owner_agent_id = d.other_agent_id
WHERE e.signal_type = ? AND d.target_agent_id = ?
GROUP BY gene_id;
```

### 2.4 Level 4: Superclass Brain — 涌现条件

SuperBrain 定义：

```
SuperBrain := ({SB_u}_{u∈U}, 𝒜, 𝒟, 𝒰)

𝒜 = 群体聚合算子
𝒟 = 模式蒸馏到 pattern library Π
𝒰 = 策略更新机制
```

Prismer 当前没有 Level 4 的概念。但所有基础组件已存在：

- `{SB_u}` = Agent 集合 ✅
- `𝒜` = Pooled Prior（待升级为 MoE） ⚠️
- `𝒟` = Gene 蒸馏（待升级为迭代 GA） ⚠️
- `𝒰` = Edge 更新 + Personality 适应 ✅

**涌现检测信号（何时认为 Superclass Brain 出现了）：**

1. **跨域迁移**：在 signal_type A 学到的 Gene 自发被应用到 signal_type B 且成功
2. **自发组合**：两个独立 Gene 被 Agent 自发串联使用且优于单独使用
3. **SSR 相变**：全局 SSR 在持续稳定后突然跃升（punctuated equilibrium）
4. **Gene 库自组织**：Gene 之间的使用模式自发形成层级结构（diagnostic → specialized）

当前北极星指标 (im_evolution_metrics) 能追踪 SSR 相变，但其他三个涌现信号没有检测机制。

---

## 3. 范畴论：需要还是不需要？

### 3.1 前一轮审查的偏差

前一轮审查从范畴论出发，识别了六个"结构性缺失"（复合律、层条件、Kan 扩展、伴随函子、操纵结构、2-态射）。回头看，这个分析有以下问题：

1. **过度抽象**：范畴论提供了一种通用语言来描述任何数学结构，但"能描述"不等于"应该用来设计"。进化引擎的核心挑战是统计学和计算复杂度问题，不是代数结构问题。

2. **错误的类比粒度**：把 Gene 执行映射为"态射"、把 Signal 映射为"对象"，只在最表面的层次成立。真正的态射应该是**重写规则**（Wolfram 意义上的），而范畴论对重写系统的处理（double pushout, sesqui-pushout）远不如 Wolfram 的超图重写规则直接。

3. **解决方案过度工程化**：建议引入"CompositeGene"（复合律）、"自动粒度选择"（层条件）、"信号共现矩阵"（Kan 扩展）等。其中信号共现矩阵（im_signal_clusters）确实有价值，但其他更直接地用 Wolfram 框架或 SuperBrain 架构来设计。

### 3.2 范畴论 vs Wolfram 框架的适用性判断

| 问题                | 范畴论方案        | Wolfram/SuperBrain 方案              | 判定                |
| ------------------- | ----------------- | ------------------------------------ | ------------------- |
| 多步策略组合        | 复合律、态射复合  | 超图重写规则链、因果图路径           | **Wolfram 更直接**  |
| 局部→全局知识一致性 | 层条件、粘合公理  | 因果不变性 + 认知距离加权池化        | **Wolfram 更具体**  |
| 泛化到新信号        | Kan 扩展          | 可约性口袋检测 + 信号聚类            | **Wolfram 更实用**  |
| 探索-利用平衡       | 伴随函子          | Thompson Sampling + 规则空间邻域搜索 | **Thompson 已足够** |
| 多信号交互          | 操纵结构 (Operad) | 超边自然编码多元关系                 | **超图更自然**      |
| 策略改进路径        | 2-态射            | 因果图 + 分枝距离                    | **因果图更可实现**  |
| 结构化验证          | 范畴等价性证明    | A/B 实验 + 北极星指标                | **实验更可靠**      |

### 3.3 结论：不引入范畴论作为设计框架

**范畴论不应作为 Prismer Evolution Engine 的设计框架。** 理由：

1. **Wolfram 的多重计算框架更贴合**——进化引擎本质上是一个超图重写系统，Wolfram 的概念（重写规则、多路系统、因果不变性、可约性口袋、规则空间）直接映射到系统的每个组件。

2. **SuperBrain 提供了具体的架构模式**——SB_u 认知签名、GA 迭代进化、群体 MoE 聚合，这些是可直接实现的工程方案，比范畴论的抽象构造更有指导意义。

3. **范畴论的价值是"事后形式化"而非"事前设计"**——当系统成熟后，用范畴论语言发表论文是合适的。但在设计和实现阶段，它增加认知负担而不增加工程价值。

4. **唯一值得保留的范畴论概念：复合律**——多步 Gene 组合确实需要一等公民支持，但实现为"CompositeGene"即可，不需要完整的范畴论框架。

---

## 4. 完备性缺口：按 Wolfram + SuperBrain 框架评估

### 4.1 评估矩阵

```
     Wolfram 框架完备性                          SuperBrain 架构完备性
     ──────────────────                          ─────────────────────
  ✅ 超图原子化存储 (im_atoms)                    ✅ Agent 实体 (u)
  ✅ 超边事件流 (im_hyperedges)                   ✅ 交互历史 (ℋ_u)
  ✅ 因果链 (im_causal_links)                     ✅ 持久记忆 (ℳ_u)
  ✅ 因果不变性验证 (α/β 写入)                    ⚠️ 个性化策略 (π_{θ|u}) — 太粗
  ✅ 重写规则 = Gene strategy                     ❌ 认知签名 (c_u)
  ✅ 规则应用 = selectGene+record                 ❌ 可靠度 (ρ_u)
  ⚠️ 多路分支 — 隐式，未追踪                      ❌ GA 迭代进化
  ⚠️ 双峰指数 ≈ 可约性探测 — 未命名              ❌ MoE 群体聚合
  ❌ 规则空间度量（Gene 间距离）                   ❌ Superclass Brain 涌现检测
  ❌ 可约性口袋显式检测与预算分配
  ❌ 分枝距离（Agent 策略相似度）
  ❌ 中性漂变保留策略
  ❌ 观察者约束形式化
```

### 4.2 优先级排序（投入/回报比）

| 优先级 | 补全项                    | 来源       | 投入 | 回报                           | 版本   |
| ------ | ------------------------- | ---------- | ---- | ------------------------------ | ------ |
| **P0** | 认知签名 c_u              | SuperBrain | 2天  | **解锁 P1-P3 的前提**          | v1.7.3 |
| **P0** | 可约性口袋显式标记        | Wolfram    | 1天  | **停止浪费 capsule 预算**      | v1.7.3 |
| **P1** | 分枝距离加权 Pooled Prior | Wolfram+SB | 2天  | **直接提升推荐质量**           | v1.7.3 |
| **P1** | Agent 可靠度 ρ_u          | SuperBrain | 1天  | **降低噪声数据影响**           | v1.7.3 |
| **P2** | 迭代 GA 蒸馏              | SuperBrain | 5天  | **蒸馏质量从运气变为系统**     | v1.8.0 |
| **P2** | 规则空间度量              | Wolfram    | 3天  | **Gene 去重 + 邻域搜索**       | v1.8.0 |
| **P2** | 中性漂变保留              | Wolfram    | 1天  | **扩大规则空间探索范围**       | v1.8.0 |
| **P3** | MoE 群体聚合              | SuperBrain | 5天  | **替代均等池化**               | v1.8.0 |
| **P3** | 涌现检测                  | Wolfram+SB | 3天  | **发现 Superclass Brain 信号** | v2.0   |
| **P3** | 复合 Gene (多步策略)      | 范畴论残留 | 2天  | **支持 Diagnostic→Repair 链**  | v2.0   |

### 4.3 不做什么（显式排除）

| 排除项                       | 来源                           | 理由                                           |
| ---------------------------- | ------------------------------ | ---------------------------------------------- |
| 完整多路系统追踪             | Wolfram                        | 分支数指数爆炸，存储不可承受，且无直接收益     |
| 因果距离衰减（替代时间衰减） | Wolfram/ENGINE-SUPERGRAPH §3.4 | BFS 遍历因果图的计算开销 > 时间衰减的精度损失  |
| 规则空间连续化               | Wolfram                        | 需要向量 DB，违反"不加基础设施"约束            |
| 范畴论框架引入               | 前一轮审查                     | 增加认知负担，不增加工程价值（见 §3）          |
| Hallucination as Navigation  | Wolfram 综述                   | 概念深刻但无法转化为具体 Evolution Engine 特性 |

---

## 5. P0 补全方案速写

### 5.1 认知签名 c_u

```typescript
// 在 EvolutionService 中新增
async computeCognitiveSignature(agentId: string): Promise<CognitiveSignature> {
  // 1. Gene 使用频谱：从 capsules 统计每个 gene_id 的使用次数
  const geneUsage = await prisma.iMEvolutionCapsule.groupBy({
    by: ['geneId'],
    where: { ownerAgentId: agentId, createdAt: { gte: thirtyDaysAgo } },
    _count: true,
  });

  // 2. Signal 域偏好：从 capsules 统计每个 signalKey 前缀的暴露次数
  const signalExposure = await prisma.iMEvolutionCapsule.groupBy({
    by: ['signalKey'],
    where: { ownerAgentId: agentId },
    _count: true,
  });

  // 3. SSR profile：每个 signal_type 的成功率
  // 4. Reliability ρ_u：capsule 质量分数的中位数
  // 5. Personality vector

  return { geneUsageVector, signalDomainVector, successProfile, personality, reliability };
}

// 认知距离（用于加权 Pooled Prior）
function cognitiveDistance(a: CognitiveSignature, b: CognitiveSignature): number {
  // 余弦距离 on gene usage vector（最有区分度）
  return 1 - cosineSimilarity(a.geneUsageVector, b.geneUsageVector);
}
```

**存储：** 不需要新表。签名是实时从 capsules/edges 计算的，可以用 Redis 缓存 (TTL 1h)。

### 5.2 可约性口袋标记

```typescript
// 在 Edge 层面标记可约性
type ReducibilityClass = 'reducible' | 'boundary' | 'irreducible';

function classifyReducibility(edge: EvolutionEdge): ReducibilityClass {
  const n = edge.successCount + edge.failureCount;
  if (n < 20) return 'boundary'; // 数据不足，不下结论

  if (edge.bimodalityIndex < 0.3) return 'reducible'; // ← 可约口袋
  if (edge.bimodalityIndex > 0.7) return 'irreducible'; // ← 计算不可约
  return 'boundary';
}

// 在 selectGene 中使用：
// 对 irreducible edges：降低 exploration 预算（不值得继续探索）
// 对 reducible edges：正常 Thompson Sampling
// 对 boundary edges：增加 exploration 预算（可能找到子口袋）
```

**影响：** 在 im_evolution_edges 增加 `reducibility` 列（VARCHAR(15)），recordOutcome 时更新。

---

## 6. ENGINE.md 落后分析

对比 ENGINE.md v0.3.0 与当前代码（v0.4.0 Signal Aggregation Engine 提交 86d73f0），以下内容已落后：

| ENGINE.md 章节    | 落后内容                        | 当前代码实际状态                                                                       |
| ----------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| §3.2 架构全景     | 无信号聚合层、无质量评估        | v0.4.0 新增 signal-extractor.ts, capsuleQuality > 0.2 过滤                             |
| §3.4 Signal 架构  | tagCoverageScore 是唯一匹配     | 三层匹配 (精确 → 前缀 → LLM 语义)                                                      |
| §4.1 Gene 选择    | `sample × coverageScore` 双因子 | 多维 rank: coverage×0.35 + memory×0.25 + confidence×0.15 + context×0.15 + quality×0.10 |
| §4.2 Pooled Prior | 无跨 Agent 全局先验修复         | base-ID 聚合、category 级全局池化                                                      |
| §5.1 指标体系     | 散落在代码各处                  | im_evolution_metrics 指标入库 + 定时采集                                               |
| §6 安全           | 无质量门控                      | capsuleQuality ≤ 0.2 只写审计不更新 edge                                               |
| §7 SDK            | 3 CLI commands                  | analyze 新增 --error/--provider/--stage, report 异步投递                               |
| §8 MVP            | "前端可视化实验中"              | Evolution Map 5 级缩放 + Louvain + Ghost + Story                                       |
| —                 | 无 im_signal_clusters           | 信号聚类（共现矩阵 + Union-Find）                                                      |
| —                 | 无 LLM 信号抽取                 | signal-extractor.ts: kimi-k2-turbo + Redis 缓存 + 正则 fallback                        |
| —                 | 无超图层                        | im_atoms + im_hyperedges + im_hyperedge_atoms + im_causal_links                        |
| —                 | 无北极星指标                    | im_evolution_metrics (SSR, CS, RP, RegP, GD, ER)                                       |
| —                 | 无 mode A/B                     | Capsule/Edge mode 字段 + standard/hypergraph 切换                                      |

**建议：** ENGINE.md 需要升级到 v0.4.0，反映 Signal Aggregation Engine 的全部变更。但这是文档工作，不影响 release。

---

## 7. 总结

### 7.1 当前方案的真实定位

从 Wolfram 多重计算框架看，Prismer Evolution Engine 已经是一个 **功能完备的超图重写系统**，具备：

- 原子化维度存储（超图层）
- 因果追踪（因果链）
- 多路分支（Thompson Sampling 隐式分支）
- 安全层（Freeze/Circuit Breaker/Rate Decay/Quality Gate）
- 可观测性（北极星指标 + A/B 实验）

但它缺少 Wolfram 框架中两个最深刻的洞察：

1. **计算不可约性感知**——不是所有 pattern 都能学到，系统应知道何时停止尝试
2. **规则空间中的结构**——Gene 之间有"距离"，Agent 之间有"距离"，这些距离决定了知识共享的有效性

从 SuperBrain 架构看，Prismer 已经具备 Level 1 (Subclass Brain) 的大部分组件，但缺少：

1. **认知签名**——解锁智能路由和加权池化的钥匙
2. **迭代进化**——从一次性蒸馏到 GA 种群进化
3. **群体智能聚合**——从均等池化到 MoE 专家路由

### 7.2 范畴论：不需要

范畴论对这个系统没有工程价值。Wolfram 框架和 SuperBrain 架构已经覆盖了所有结构性需求，且更加具体和可实现。如果未来要发表论文，范畴论语言可以用于形式化表述，但不应指导设计和实现。

### 7.3 下一步行动

v1.7.3 应补全 P0 项（认知签名 + 可约性标记），并将分枝距离引入 Pooled Prior。这三个改动总计约 5 天工作量，预期效果：

- Pooled Prior 推荐质量提升（从均等池化到认知距离加权）
- Capsule 预算效率提升（不再在不可约 pattern 上浪费探索）
- 为 v1.8.0 的迭代 GA 蒸馏和 MoE 聚合打下数据基础

---

_Last updated: 2026-03-22_
