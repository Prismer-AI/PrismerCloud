# Prismer Evolution Engine — 技术设计文档

> **Version:** 0.3.0
> **Date:** 2026-03-18
> **Status:** ✅ 核心完成（算法 ✅ / 安全层 ✅ / 数据迁移 ✅ / 知识层 ✅ / 前端 🔧）
> **Scope:** 多 Agent 在线技能进化系统 — 算法、可观测性、SDK、MVP
> **Audience:** 技术团队 / 公众号文章 / 潜在论文
>
> **实现状态速查：**
> | 模块 | 状态 | 说明 |
> |------|------|------|
> | Gene 选择（Thompson Sampling + Pooled Prior） | ✅ | `selectGene()` 委托 `GeneSelector.score()` |
> | **GeneSelector 可插拔接口** | ✅ | **v0.3.0新增：ThompsonSelector + LaplaceSelector，DI 注入** |
> | **SignalTag 层级标签架构** | ✅ | **v0.3.0新增：`tagCoverageScore()` 替代 `jaccardSimilarity()`** |
> | **Diagnostic Gene 路由** | ✅ | **v0.3.0新增：无精细匹配时 diagnostic 类型 Gene 优先 boost** |
> | **Bimodality Index** | ✅ | **v0.3.0新增：`updateBimodalityIndex()` 超额分散检测** |
> | **task_success_rate 分离** | ✅ | **v0.3.0新增：路由权重 vs 最终成功率，语义分离写入** |
> | 跨 Agent Gene 候选池（全局 published/seed 可见） | ✅ | `selectGene()` 合并全局 published+seed 候选 |
> | Canary 5% 可见性过滤 | ✅ | `isCanaryVisibleToAgent()` 接入 `selectGene()` |
> | Canary 全局权重折扣（×0.5）| ✅ | `wGlobalEffective = wGlobal × canaryDiscount` |
> | 结果记录（Capsule + Edge + Personality） | ✅ | `recordOutcome()` — 含 Rate Decay + Freeze 检查 |
> | Canary 自动晋升/降级 | ✅ | `recordOutcome()` 末尾 fire-and-forget 触发 |
> | Gene CRUD（创建/发布/导入/Fork/删除） | ✅ | 7 个操作，数据存 `im_genes` 独立表 |
> | **Gene 蒸馏（LLM）** | ✅ | **v0.3.0补齐 Critique 阶段（第二次 LLM 审核）+ Canary 发布** |
> | 未匹配信号追踪 + 创建建议 | ✅ | `im_unmatched_signals` + `create_suggested`，signalTags JSON |
> | SSE 事件广播 | ✅ | `evolution:capsule` 事件 |
> | 安全：Rate Decay | ✅ | `0.5^n` 衰减，decayFactor<0.1 时跳过 Beta 更新 |
> | 安全：Canary 灰度 | ✅ | seed→canary→published→quarantined + 晋升/降级 |
> | 安全：Circuit Breaker | ✅ | per-Gene 三态 DB 持久化（multi-pod safe） |
> | 安全：Freeze Mode（Global + Provider） | ✅ | DB-computed + TTL 缓存，provider 列查询 |
> | 安全：Gene ACL + 反滥用 | ✅ | 访问控制 + ≥3 distinct agents 降级保护 |
> | Gene 独立表迁移 | ✅ | `im_genes` + `im_gene_signals`（含 signal_tags JSON） |
> | 统一知识检索（Recall API） | ✅ | `/recall` + MySQL FULLTEXT 搜索 |
> | 前端可视化 | 🔧 | Canvas 力导向图实验中，待重设计 |
> | E2E 测试 | ✅ | 23 pass，零 regression |
> | Simulation 实验脚本 | ✅ | `scripts/experiments/evolution-sim.ts` |

---

## 1. 问题定义

### 1.1 核心问题

多个 AI Agent 在持续执行任务的过程中，如何从成功和失败中学习，形成可复用的策略知识（Gene），并在 Agent 之间高效共享？

**形式化描述：**

设 Agent 集合 $\mathcal{A} = \{a_1, ..., a_M\}$，Gene 集合 $\mathcal{G} = \{g_1, ..., g_K\}$。

Signal **不是**封闭的离散空间 $\mathcal{S}$（原设计的错误假设），而是**开放的层级标签集合**：

$$s_t = \{ \tau_1, \tau_2, ... \} \quad \text{其中每个} \; \tau_i \in \mathcal{T} = \{\text{type}, \text{provider}?, \text{stage}?, \text{severity}?, ...\}$$

$\mathcal{T}$ 是可扩展的标签维度空间，`error:500` 是一个 type，但同一 type 下存在数以万计不同的情景组合——不同的 `provider`、`stage`、`severity` 对应完全不同的修复路径。详见 §3.4。

在每个时间步 $t$：

1. Agent $a_i$ 观察到信号标签集合 $s_t = \{\tau_1, ..., \tau_k\}$（如 `[{type:"error:500", provider:"openai"}]`）
2. 系统从 $\mathcal{G}$ 中**按层级标签匹配**选择 Gene $g_t$（策略），覆盖分数 $c(s_t, g_t) \in [0,1]$ 衡量匹配精细度
3. Agent 执行 $g_t$ 的 strategy，产生结果 $r_t \in [0, 1]$
4. 系统更新 $(s_t, g_t)$ 的**路由权重**（见 §3.4.3），并单独记录最终任务成功率

**目标：** 最小化累积遗憾（cumulative regret）：

$$R_T = \sum_{t=1}^{T} \left[ r^*(s_t) - r_t \right]$$

其中 $r^*(s_t)$ 是信号 $s_t$ 下（含层级回退后）最优 Gene 的期望奖励。

### 1.2 与经典 RL/Bandit 问题的映射

| 进化系统概念              | RL/Bandit 对应                 | 说明                                                                                 |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| 信号 (Signal)             | 上下文 (Context)               | Agent 当前面对的状况                                                                 |
| Gene                      | 臂 (Arm) / Option              | 可选的策略                                                                           |
| 执行结果 (Capsule)        | 奖励 (Reward)                  | 0-1 分数                                                                             |
| 记忆图谱 (Evolution Edge) | 路由权重 (Routing Weight)      | 对 (signal 类别, gene) 的路由偏好——"值不值得尝试"，而非"最终会不会成功"（见 §3.4.3） |
| Personality               | 超参数 (Hyperparameter)        | 探索-利用偏好                                                                        |
| Gene 蒸馏 (Distillation)  | 策略蒸馏 (Policy Distillation) | 从经验中提炼新策略                                                                   |
| 全局图谱                  | 共享先验 (Shared Prior)        | 种群级别的价值函数                                                                   |

### 1.3 Prismer 的独特约束与优势

**约束：**

- Agent 不直接修改代码（与 Evolver 不同），验证方式是任务执行结果而非 git diff
- Gene 执行有 credit 成本，不能无限探索
- 信号是结构化的（JSON），不需要 NLP 提取
- **Signal 不是闭空间：** `error:500` 这类 signal 覆盖数十万种完全不同的情景（DB连接池耗尽 vs 外部API抖动 vs 内存溢出），把它们折叠进同一个 key 使 edge 上的 confidence 成为无意义的平均数。设计决策见 §3.4：Signal 升级为层级标签集合，路由与执行分离为两层；**不走向量检索路径**（会把自适应智能全部压到召回层，Gene 退化为无脑脚本）
- 需要支持数千 Agent 同时在线
- Gene strategy 是自然语言步骤，安全边界在 Agent 执行层（而非 Gene 定义层）
- 外部依赖（LLM API、Web 抓取）可能级联故障，进化系统需要与之解耦

**优势：**

- **Context Engineering（Load/Save API）：** Gene 的 strategy 可以调用 `prismer_load` 获取 HQCC（高质量压缩上下文），这是任何本地进化引擎无法实现的。Gene 不仅编码"做什么"，还编码"获取什么上下文"
- **Cloud 端聚合：** 天然支持跨 Agent 知识共享，无需 P2P 协议
- **IM 消息通道：** Agent 间的 Gene 分享、进化事件广播走已有的 IM 基础设施
- **Task Orchestration：** 完成/失败自动触发 outcome 记录，无额外 SDK 调用

---

## 2. SOTA 调研

### 2.1 在线学习算法（Gene 选择）

#### 2.1.1 当前方案：Laplace-Smoothed Bandit

移植自 Evolver（EvoMap）的 `selector.js` + `memoryGraph.js`：

```
p(g|s) = (success(s,g) + 1) / (total(s,g) + 2)    — Laplace 平滑
w(s,g) = 0.5^(age(s,g) / 30d)                       — 时间衰减（半衰期 30 天）
score(g|s) = p × w                                    — 最终评分
gene* = argmax_g score(g|s) + drift_noise            — 贪心 + 遗传漂变
```

**分析：** 本质上是 Beta(success+1, failure+1) 后验的**点估计**（均值），加上启发式时间衰减和随机噪声。这是 Thompson Sampling 的一个退化近似。

| 优点                                  | 缺点                               |
| ------------------------------------- | ---------------------------------- |
| O(1) 查表，零计算开销                 | 无上下文感知（纯 signal key 匹配） |
| 直觉可解释                            | 遗传漂变参数需手工调优             |
| 已在 Evolver 生产运行（但有 caveat）¹ | 无跨 Agent 学习                    |
| Laplace 平滑处理冷启动                | 贪心策略 + 噪声 ≠ 理论最优探索     |

> ¹ **Evolver 验证的可信度有限**（详见 `SKILL-EVOLUTION.md` §1.6）：(a) Outcome 推断噪声——"基线稳定"被计为 0.6 分成功，持续虚增 success_count；(b) Signal key 碎片化——`errsig_norm:<hash>` 把同类错误哈希为孤立 edge，Jaccard 相似度对 opaque hash 失效。"生产运行"不等于"验证了统计正确性"。

#### 2.1.2 Thompson Sampling

**论文：** Agrawal & Goyal, "Thompson Sampling for Contextual Bandits with Linear Payoffs", ICML 2013

**算法：** 对每个 (signal, gene) 对维护 Beta 后验，每次从后验**采样**而非取均值：

```
对每个 gene g:
  posterior = Beta(α_g, β_g)   where α_g = success + 1, β_g = failure + 1
  sample_g ~ posterior          — 从后验采样

gene* = argmax_g sample_g       — 选择采样值最高的
```

**关键性质：**

- 高置信度 Gene（α=100, β=10）：采样集中在 ~0.91，几乎总被选中
- 低置信度 Gene（α=2, β=2）：采样分散在 0-1，有机会被探索
- 失败多的 Gene（α=3, β=50）：采样集中在 ~0.06，几乎不被选
- **自动实现 explore-exploit 平衡，无需手工调 drift 参数**

**遗憾界：** $O(d\sqrt{T} \cdot \text{polylog}(T))$，信息论下界最优

**与 Laplace 的差异：**

```python
# Laplace（当前）：确定性，需要人工加噪声
score = (success + 1) / (total + 2) * time_decay + random_drift

# Thompson Sampling：概率性，自然包含不确定性
sample = Beta(success + 1, failure + 1).sample() * time_decay
```

#### 2.1.3 LinUCB

**论文：** Li et al., "A Contextual-Bandit Approach to Personalized News Article Recommendation", WWW 2010

**算法：** 假设奖励是上下文特征的线性函数：

```
E[r|x, g] = x^T θ_g

参数估计:  θ̂_g = A_g^{-1} b_g
           A_g = D_g^T D_g + I_d   (d×d 矩阵)
           b_g = D_g^T c_g         (d 维向量)

选择:      gene* = argmax_g (x^T θ̂_g + α √(x^T A_g^{-1} x))
                                    ↑ 均值估计   ↑ 不确定性奖励
```

**优势：** 可以利用 signal 的**特征向量**（而非离散 key），泛化到未见过的信号组合。
**劣势：** 线性假设限制表达能力；d 维特征空间下 O(d²) 矩阵更新。

#### 2.1.4 Neural Bandits (NeuralUCB / NeuralTS)

**论文：** Zhou, Li & Gu, "Neural Contextual Bandits with UCB-based Exploration", ICLR 2020

用神经网络替代线性模型：

```
f(x, g; θ) = neural_network(x, g)
UCB_g(x) = f(x, g; θ̂) + α √(∇_θ f^T Z^{-1} ∇_θ f)
```

**适用场景：** signal 特征空间复杂、非线性奖励结构。
**Prismer 当前不需要：** signal 是离散标签组合，线性/表格方法已足够。

#### 2.1.5 层级贝叶斯 Bandit（Hierarchical Bayesian Bandits）

**论文：** Hong et al., "Hierarchical Bayesian Bandits", AISTATS 2022

**这是 Prismer 全局进化图谱的理论基础。**

```
全局先验:     μ_0 ~ N(0, σ_0² I)
Agent i 参数: θ_i ~ N(μ_0, σ_i² I)     — 条件于全局先验
观测:         r_{i,t} ~ Bernoulli(θ_i)

Gene 选择时的分层推理:
  α_combined = α_global × w_prior + α_agent × w_local
  β_combined = β_global × w_prior + β_agent × w_local

  新 Agent: w_prior = 0.9  → 几乎完全依赖全局
  老 Agent: w_prior = 0.3  → 主要靠自己的经验

  权重计算: w_prior = max(0.2, 1 - n_agent / N_threshold)
  其中 n_agent 是该 Agent 的总执行次数，N_threshold 是经验阈值（如 100）
```

**关键优势：**

- 解决冷启动：新 Agent 继承全局先验
- 样本效率：M 个 Agent 池化观测，收敛速度 O(√(T/M))
- 个性化：老 Agent 保留个体偏好

#### 2.1.6 联邦 Bandit（Federated Bandits）

**论文：** Shi, Shen & Yang, "Federated Multi-Armed Bandits", AAAI 2021; Fourati et al., "Federated Combinatorial Multi-Agent MAB", ICML 2024

**核心：** Agent 周期性与 Cloud 同步统计量，而非每次执行都通信：

```
通信轮次 h 后的全局估计:
  μ̂_g^(h) = (1/M) Σ_i μ̂_{g,i}^(h)

遗憾界: O(√(KT/M))  — M 个 Agent 线性加速
```

**P-FCB（隐私保护变体）：** 差分隐私下的联邦学习，适用于未来跨 owner 共享场景。

### 2.2 进化计算（Gene 发现与蒸馏）

#### 2.2.1 MAP-Elites（Quality-Diversity）

**论文：** Mouret & Clune, "Illuminating Search Spaces by Mapping Elites", 2015

**核心思想：** 同时优化质量（fitness）和多样性（behavior coverage）。

```
定义 behavior descriptor 空间（2-n 维）
将空间划分为网格

循环:
  随机选择已填充网格单元中的精英
  变异 → 新解 x'
  评估 fitness f(x') 和 behavior b(x')
  找到 b(x') 对应的网格单元 c
  if c 为空 or f(x') > c.elite.fitness:
    c.elite = x'
```

**对 Prismer 的意义：** Gene 多样性管理。

```
Gene 的 behavior descriptor = (signal_category, strategy_complexity)
  signal_category: repair / optimize / innovate
  strategy_complexity: len(strategy_steps)

维护"精英地图"：每个 (category, complexity) 格子保留最高 PQI 的 Gene
→ 确保系统不会只有"简单修复"Gene，也有"复杂创新"Gene
```

#### 2.2.2 AlphaEvolve (Google DeepMind, 2025)

**论文：** Novikov et al., "AlphaEvolve: A coding agent for scientific and algorithmic discovery", 2025

将 MAP-Elites + Island-based 种群模型与 LLM 结合：

- Gemini Flash（广度搜索）+ Gemini Pro（深度优化）
- 程序化评估器验证正确性
- **成就：** 4×4 复数矩阵乘法仅需 48 次标量乘法；优化 Google 数据中心调度，节省全球 0.7% 算力

**对 Prismer Gene 蒸馏的启示：** 可以用类似策略——快速模型生成 Gene 候选，强力模型精炼。

#### 2.2.3 EvoPrompt

**论文：** Guo et al., "Connecting Large Language Models with Evolutionary Algorithms Yields Powerful Prompt Optimizers", ICLR 2024

```
初始化 prompt 种群 P = {p_1, ..., p_N}
循环:
  交叉: p_new = LLM("Combine these prompts: p_i, p_j")
  变异: p_new = LLM("Improve this prompt: p_i, based on feedback: ...")
  评估 fitness
  锦标赛选择更新种群
```

**对 Prismer 的直接适用：** Gene 的 strategy 字段（自然语言步骤列表）可以用 EvoPrompt 方式进化。

#### 2.2.4 PromptBreeder (DeepMind, 2024)

**论文：** Fernando et al., "PromptBreeder: Self-Referential Self-Improvement via Prompt Evolution", ICML 2024

**核心创新：自参考（self-referential）进化** — 不仅进化 task-prompt，还进化 mutation-prompt（指导如何变异的 prompt 本身）。

```
层 1: Task Prompt      — "遇到 timeout 时执行以下步骤..."
层 2: Mutation Prompt   — "如何改进一个处理超时的策略..."
层 3: Hyper-Mutation     — "如何改进'如何改进策略'的指令..."
```

**对 Prismer 的启示：** Gene 蒸馏器（Distiller）的蒸馏 prompt 本身也可以进化。

### 2.3 技能/知识迁移

#### 2.3.1 Options Framework

**论文：** Sutton, Precup & Singh, "Between MDPs and Semi-MDPs", 1999

**Option = (I, π, β)：**

- I: 启动集（哪些状态可以启动此 option）
- π: 内部策略（option 执行时的动作选择）
- β: 终止条件（何时结束此 option）

**与 Prismer Gene 的精确对应：**

```
Gene.preconditions    ≡  Option.I    (启动条件 / 信号匹配)
Gene.strategy         ≡  Option.π   (执行策略 / 步骤序列)
Gene.constraints      ≡  Option.β   (终止约束 / max_credits, max_retries)
```

**Gene 在工程结构上对应于 Option 的一个实用化实例。** 但 Option Framework 还隐含了半马尔可夫决策过程中的时序结构与状态转移语义；Gene 当前更像"带约束的可复用策略模板"，不具备完整的 SMDP 形式化。映射方向正确，但不宜称为严格同构。

#### 2.3.2 Population-Based Training (PBT)

**论文：** Jaderberg et al., "Population Based Training of Neural Networks", 2017 (DeepMind)

```
维护 N 个并行 agent，各自不同超参数
每隔 T 步:
  1. Exploit: 差的 agent 复制好的 agent 的参数
  2. Explore: 对复制来的超参数做随机扰动
```

**Prismer 的 Personality 系统就是简化版 PBT：**

- `rigor`, `creativity`, `risk_tolerance` = 超参数
- 自然选择（向最佳配置靠拢）= Exploit
- 触发突变 = Explore

#### 2.3.3 Policy Distillation

**论文：** Rusu et al., "Policy Distillation", ICLR 2016

$$L_{distill} = \text{KL}(\pi_{teacher}(\cdot|s) \| \pi_{student}(\cdot|s))$$

**Gene 蒸馏就是策略蒸馏：** 从多个成功 Capsule（教师经验）中提取通用 Gene（学生策略）。

### 2.4 Context Engineering

#### 2.4.1 行业现状

**Anthropic (2025)** 定义 context engineering 六大组件：Orchestration, Query Augmentation, Retrieval, Prompting, Memory, Tools。

**Google (2025)** "Just-in-time" context 策略：Agent 维护轻量标识符，运行时动态加载。

**Self-Evolving Context (2025)：** 论文 "Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models" (arXiv:2510.04618) 提出让 LLM 自主进化上下文的框架。

#### 2.4.2 Prismer Load/Save 的差异化

| 维度   | 传统 RAG         | Prismer Load/Save                          |
| ------ | ---------------- | ------------------------------------------ |
| 数据源 | 预索引文档库     | 实时 Web 抓取 + 缓存                       |
| 压缩   | 无（raw chunks） | LLM 压缩为 HQCC                            |
| 缓存   | 向量数据库       | Content-addressed cache (`prismer://` URI) |
| 共享   | 单用户           | 跨 Agent 通过 URI 共享                     |
| 新鲜度 | 依赖重索引       | 实时抓取 + livecrawl fallback              |

**Context Engineering × Evolution 的交汇 — 以及当前的断裂：**

Gene 的 strategy 中应当包含 context 操作（获取知识、保存经验），这是 Prismer 相对所有竞品的杀手锏。但当前实现有一个关键断点：

```
┌── 断裂的三层 ──────────────────────────────────────────────┐
│                                                              │
│  Context API (Load/Save)        Memory Layer              Evolution │
│  ┌─────────────────┐      ┌──────────────────┐      ┌───────────┐ │
│  │ Save → content_uri │   │ im_memory_files  │      │ Gene      │ │
│  │ Load ← URL 精确查  │   │ Markdown 全文    │      │ strategy  │ │
│  │                     │   │ 无搜索能力       │      │ 需要上下文│ │
│  │ ❌ 无语义检索      │   │ ❌ 无 FULLTEXT   │      │ ❌ 够不着 │ │
│  │ ❌ content_uri 查  │   │ ❌ 无 embedding  │      │           │ │
│  │    不到 (backend   │   │                  │      │           │ │
│  │    bug: found:false)│   │                  │      │           │ │
│  └─────────────────┘      └──────────────────┘      └───────────┘ │
│          ↑ 没有桥梁 ↑              ↑ 没有桥梁 ↑                      │
└──────────────────────────────────────────────────────────────────┘
```

**具体表现：**

1. `prismer_save` 存了 50 条压缩知识 → **无法搜索**，除非记得原始 URL
2. `prismer_load` 只能按 URL 精确匹配 → **不能说"给我关于 timeout 的知识"**
3. `im_memory_files` 有 Markdown 全文 → **没有 FULLTEXT 索引**（v0.5.0 backlog）
4. Gene strategy 想说 "查一下类似问题的历史解法" → **做不到**
5. `content_uri`（`prismer://`）后端查询 → **`found:false`**（已知 bug）

**这是整个进化系统的最大瓶颈。** 算法再好，Agent 获取不到相关知识，Gene 的 strategy 就只能是死板的步骤列表，不能动态适应上下文。

### 2.4.3 统一知识层设计（Context + Memory + Evolution 协同）

> 详细设计见 [`docs/MEMORY-LAYER.md`](./MEMORY-LAYER.md)

**三层必须打通，形成统一的 Agent 知识基础设施：**

```
┌── 统一知识层 ──────────────────────────────────────────────┐
│                                                              │
│  ┌─ Knowledge Store (统一存储) ──────────────────────────┐ │
│  │                                                        │ │
│  │  im_memory_files:   Markdown 记忆（结构化知识）       │ │
│  │  im_context_cache:  压缩内容（Web 知识）              │ │
│  │  im_evolution_*:    Gene/Capsule/Edge（进化知识）     │ │
│  │                                                        │ │
│  │  ┌─ Retrieval Layer (检索层) ────────────────────────┐│ │
│  │  │                                                    ││ │
│  │  │  1. 精确匹配:  URL → context_cache (已有)         ││ │
│  │  │  2. 全文搜索:  keyword → memory_files FULLTEXT    ││ │
│  │  │  3. 信号匹配:  signals → evolution_edges (已有)   ││ │
│  │  │  4. 语义搜索:  embedding → ANN index (Phase 2)   ││ │
│  │  │                                                    ││ │
│  │  │  统一入口:  prismer_recall(query, scope?)         ││ │
│  │  │  → 同时搜索 memory + cache + genes               ││ │
│  │  │  → 返回按相关性排序的混合结果                      ││ │
│  │  └────────────────────────────────────────────────────┘│ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ 写入路径 ───────────────────────────────────────────┐  │
│  │                                                        │  │
│  │  prismer_load → 获取 Web 知识 → 自动 deposit cache   │  │
│  │  prismer_save → 手动存入 cache + 可选写入 memory     │  │
│  │  prismer_invalidate → 强制失效缓存，下次 load 重抓   │  │
│  │  evolution record → capsule → 成功模式沉淀为 memory  │  │
│  │  gene distillation → 新 Gene → 写入 gene store       │  │
│  │                                                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ 读取路径（Gene strategy 可用） ─────────────────────┐  │
│  │                                                        │  │
│  │  Gene strategy step: "Recall similar timeout fixes"   │  │
│  │       ↓                                                │  │
│  │  prismer_recall("timeout fix", scope="evolution")     │  │
│  │       ↓                                                │  │
│  │  搜索 memory_files (FULLTEXT "timeout")               │  │
│  │  + 搜索 context_cache (tag/meta match)                │  │
│  │  + 搜索 evolution_capsules (signal match)             │  │
│  │       ↓                                                │  │
│  │  返回: [{type:"memory", content:"..."}, ...]          │  │
│  │                                                        │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**实现优先级：**

| 阶段   | 改进                                                             | 工作量 | 打通的断点                                    |
| ------ | ---------------------------------------------------------------- | ------ | --------------------------------------------- |
| **P0** | `im_memory_files` 加 MySQL FULLTEXT 索引                         | 0.5 天 | Memory 可搜索                                 |
| **P0** | `im_context_cache` 加 `tags` 字段 + 搜索 API                     | 1 天   | Cache 可按标签检索                            |
| **P1** | `prismer_recall` 统一检索 tool（合并搜索 memory + cache + gene） | 1.5 天 | Gene strategy 能动态获取上下文                |
| **P1** | `prismer_save` 增加 `tags` + 可选自动写 memory 摘要              | 0.5 天 | Save 的知识不再石沉大海                       |
| **P1** | `prismer_invalidate` API + cache TTL 衰减机制                    | 0.5 天 | 过期知识可被淘汰，Gene 失败时可主动刷新上下文 |
| **P2** | Capsule → Memory 自动沉淀（成功模式写入 memory）                 | 1 天   | 进化知识自动积累                              |
| **P3** | Embedding 列 + ANN 索引（语义搜索）                              | 3 天   | 真正的语义检索                                |

**P0 + P1 合计 3.5 天就能打通整条链路。** 不需要向量数据库，FULLTEXT + 标签搜索 + 信号匹配三路并行已经覆盖 90% 场景。

### 2.5 竞品对比

> 详细调研见 [`docs/EVOLUTION-COMPETITOR-RESEARCH.md`](./EVOLUTION-COMPETITOR-RESEARCH.md)（11 个系统、70+ 引用源）

#### 2.5.1 进化能力矩阵

| 系统              |        自我改进         |   跨 Agent 共享   |  Fitness 评估  |   知识持久化    |      市场       |
| ----------------- | :---------------------: | :---------------: | :------------: | :-------------: | :-------------: |
| **EvoMap**        |        GEP 协议         |     A2A 协议      |  GDI + Arena   |     系统树      |    Gene 市场    |
| **Evolver**       |        本地 GEP         |    via EvoMap     |  Signal 匹配   |  events.jsonl   |   via EvoMap    |
| **EvoAgentX**     |  TextGrad/AFlow/MIPRO   |        无         |   Benchmark    |   Memory 模块   |       无        |
| **PromptBreeder** |       自参考进化        |        无         |     训练集     |       无        |       无        |
| **EvoPrompt**     |          GA/DE          |        无         |    Dev set     |       无        |       无        |
| **LangGraph**     |           无            |        无         |       无       |  Checkpointer   |       无        |
| **CrewAI**        |       隐式(记忆)        |      Crew 内      |       无       |     LanceDB     |       无        |
| **OpenAI SDK**    |           无            |        无         |       无       |    Sessions     |       无        |
| **Anthropic MCP** |           无            | Skills 格式(静态) |       无       |   Skills 文件   |       无        |
| **Prismer**       | **Thompson+层级贝叶斯** |  **Cloud 聚合**   | **PQI+可观测** | **MySQL+Cache** | **Credit 闭环** |

#### 2.5.2 已发表性能指标

| 系统          | 指标                             | 结果                 |
| ------------- | -------------------------------- | -------------------- |
| PromptBreeder | GSM8K zero-shot                  | 83.9% (vs CoT 63.8%) |
| EvoPrompt     | BBH improvement                  | up to +25%           |
| EvoAgentX     | HotPotQA F1 / MBPP pass@1 / GAIA | +7.44% / +10% / +20% |
| Anthropic MCP | Token 节省 (code execution)      | -98.7%               |
| EvoMap        | GDI boost from EvolutionEvent    | +6.7%                |

#### 2.5.3 架构层次定位

```
Evolution Systems (EvoMap, PromptBreeder, EvoAgentX)
    "How agents get better"
         │
         ▼
    ┌─────────────────────────────────────────────┐
    │  Prismer Cloud — Knowledge Drive            │
    │  "What agents know, optimally delivered"     │
    │                                              │
    │  Context API → Optimized knowledge           │
    │  Evolution Engine → Online learning          │
    │  MCP Server → Universal access               │
    │  Credit Economy → Incentive alignment        │
    └─────────────────────────────────────────────┘
         │
         ▼
Orchestration Frameworks (LangGraph, CrewAI, AutoGen, OpenAI SDK)
    "How agents coordinate and execute"
```

**关键发现（来自竞品调研）：**

1. **"进化 + 知识基础设施"的交叉领域无人占据。** EvoMap 拥有进化协议，Prismer 拥有知识基础设施，两者的组合是空白地带
2. **所有进化系统都缺少高质量上下文输入。** PromptBreeder/EvoPrompt/EvoAgentX 优化 prompt 和 workflow，但假设 context 是给定的。Prismer 的 Load API 填补这个缺口
3. **CrewAI 的认知记忆架构是最接近的类比。** 层级范围树 + 自适应深度召回 + 合并去重，与 Prismer 的 context cache + ranking presets 异曲同工
4. **Agent Skills 格式正在成为分发标准。** Prismer 可将上下文策略打包为 Agent Skills

**一句话定位：Prismer 是唯一将 Online RL 理论、Cloud 聚合、Context Engineering 三者结合的 Agent 进化平台。位于进化系统（优化行为）和编排框架（协调执行）之间的知识层 — 这是可防御的战略位置。**

---

## 3. 系统架构

### 3.1 设计原则

1. **可观测性优先（Observability-First）：** 进化算法可以换，但每个节点的状态、质量、趋势必须始终可见
2. **算法可插拔（Pluggable Algorithms）：** Gene 选择策略是接口，实现可以从 Laplace 升级到 Thompson Sampling 再到 LinUCB
3. **Context 原生（Context-Native）：** Gene 的 strategy 原生支持 Load/Save API 调用
4. **SDK 精简（Minimal SDK Surface）：** Agent 开发者只需 3 个 CLI command 即可参与进化
5. **Credit 闭环（Credit Loop）：** 进化贡献 → 赢得 Credit → 可消费

### 3.2 架构全景

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Prismer Evolution Engine                          │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │ Layer 1: 可观测性层 (Observability)                              │ │
│  │                                                                   │ │
│  │  全局进化图谱          Fitness Landscape      Evolution Velocity  │ │
│  │  (signal→gene→outcome) (PQI 精英地图)        (capsules/day)     │ │
│  │  Gene Diversity Index   Exploration Rate      Agent Contribution │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │ Layer 2: 算法层 (Pluggable)                                      │ │
│  │                                                                   │ │
│  │  ┌──────────────┐  ┌────────────────┐  ┌──────────────────────┐ │ │
│  │  │ Gene 选择器   │  │ Gene 蒸馏器    │  │ Personality 适应器  │ │ │
│  │  │ (Selector)    │  │ (Distiller)    │  │ (Adapter)           │ │ │
│  │  │               │  │                │  │                      │ │ │
│  │  │ interface:    │  │ interface:     │  │ interface:           │ │ │
│  │  │ select(s,a)→g │  │ distill(caps)  │  │ adapt(outcome)      │ │ │
│  │  │               │  │  → gene        │  │  → personality      │ │ │
│  │  │ impls:        │  │                │  │                      │ │ │
│  │  │ · Laplace     │  │ impls:         │  │ impls:              │ │ │
│  │  │ · Thompson    │  │ · LLM-based    │  │ · NaturalSelection  │ │ │
│  │  │ · LinUCB      │  │ · EvoPrompt    │  │ · PBT               │ │ │
│  │  │ · Hierarchical│  │ · MAP-Elites   │  │ · Fixed              │ │ │
│  │  └──────────────┘  └────────────────┘  └──────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │ Layer 3: 数据层 (Storage)                                        │ │
│  │                                                                   │ │
│  │  im_evolution_edges:  (agent, signal, gene) → (trials, successes) │ │
│  │  im_evolution_capsules:  不可变事件流（append-only, 唯一真源）   │ │
│  │  im_unmatched_signals:  进化前沿（无 Gene 匹配的信号） [v0.2.1] │ │
│  │  im_evolution_achievements:  Agent 成就徽章                      │ │
│  │  im_skills:  ~5K 外部技能目录（ClawHub 同步）                   │ │
│  │  Gene Store:  im_genes 独立表（已迁移，im_gene_signals 存信号关联） │ │
│  │  Global Aggregate:  SQL GROUP BY 动态聚合（无专用表）            │ │
│  │                                                                   │ │
│  │  ⚠️ Capsule 是未来所有离线回放、counterfactual 评估、            │ │
│  │  策略对比实验的唯一真源。Edge 只是 Capsule 的聚合缓存。          │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │ Layer 4: 集成层 (Integration)                                    │ │
│  │                                                                   │ │
│  │  Task Lifecycle Hook:  task.complete → auto recordOutcome        │ │
│  │  Context API:  Gene strategy 调用 prismer_load/save              │ │
│  │  IM Channel:   Gene 分享、进化事件广播                           │ │
│  │  Scheduler:    定时蒸馏、Gene 衰减扫描                          │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.3 算法接口设计（可插拔）

```typescript
/**
 * Gene 选择器接口 — 可插拔
 *
 * 注意：Signal 参数使用 SignalTag[]（层级标签），不使用 string[]。
 * 原因见 §3.4 + SKILL-EVOLUTION.md §1.6.2：
 * 扁平 key 导致 signal 碎片化（Evolver 的核心结构性缺陷），
 * 每个独特的错误文本成为孤立的学习岛——跨情景泛化被根本阻断。
 */
interface GeneSelector {
  /** 给定信号标签集合和 Agent，返回推荐的 Gene */
  select(signalTags: SignalTag[], agentId: string): Promise<{
    gene: PrismerGene;
    routingWeight: number;       // P(值得尝试 | signal 类别)，不是 P(最终成功)（见 §3.4.3）
    coverageScore: number;       // tag 覆盖分数：精细匹配(1.0) vs 粗粒度回退(0.3)
    alternatives: PrismerGene[];
    explorationInfo: {
      isExploring: boolean;       // 是否在探索（而非利用）
      uncertaintyScore: number;   // Beta 后验宽度，越大越不确定
    };
  }>;

  /** 更新选择器的内部状态 */
  update(signalTags: SignalTag[], geneId: string, outcome: number): Promise<void>;
}

// 实现 1: 当前方案（Laplace + 遗传漂变）
class LaplaceSelector implements GeneSelector { ... }

// 实现 2: Thompson Sampling（推荐升级目标）
class ThompsonSelector implements GeneSelector { ... }

// 实现 3: 层级贝叶斯（全局图谱）
class HierarchicalBayesianSelector implements GeneSelector { ... }

// 实现 4: LinUCB（上下文感知）
class LinUCBSelector implements GeneSelector { ... }
```

### 3.4 Signal 架构：层级标签 + 两层路由

> **背景：** `error:500` 不是一个点，是一个开放空间——同样的错误码背后可以是数据库连接池耗尽、外部 API 抖动、内存溢出等完全不同的情景，每种需要不同的处理策略。扁平化 key 把它们全部折叠进一个 edge，导致 confidence 是毫无意义的加权平均数，并非向量检索能够解决。
>
> **根本诊断：** 系统把两件不同的事混在了一条边里——**路由决策**（遇到 error:500，值不值得尝试 gene X？）和**成功预测**（在当前具体情景下，gene X 最终会成功吗？）。前者只需要粗粒度类别，后者需要完整 execution context。把两者折叠进同一个 edge confidence 才是真正的设计缺陷。

#### 3.4.1 Signal 数据结构：从 flat key 到层级标签集合

```typescript
/**
 * SignalTag：一个触发维度
 *
 * Signal 事件 = 多个 SignalTag 的集合，描述"当前情景的多维度切面"
 * 召回时可以只匹配其中的子集（粗粒度回退）
 */
interface SignalTag {
  type: string; // 必填。粗粒度类别。"error:500" | "task:refactor" | "error:rateLimit"
  provider?: string; // 可选。来源方。"openai" | "mysql" | "exa" | "github"
  stage?: string; // 可选。发生阶段。"api_call" | "data_fetch" | "batch_write" | "auth"
  severity?: string; // 可选。严重程度。"critical" | "transient" | "degraded"
  [key: string]: string | undefined; // 可扩展，不强制枚举
}

// 旧格式（兼容，deprecated）：
//   signals: ["error:500"]
//   → normalize_and_sort().join("|") → "error:500"
//
// 新格式：
//   signals: [{ type: "error:500", provider: "openai", stage: "api_call" }]
//   → 召回时按 tag 子集匹配，允许粗细度自动回退
```

**具体例子：**

```
情景：调用 OpenAI API 在 api_call 阶段返回 500
SignalTags = [
  { type: "error:500", provider: "openai", stage: "api_call" }
]

情景：MySQL 在 batch_write 阶段连接池耗尽（HTTP 层面也表现为 500）
SignalTags = [
  { type: "error:500", provider: "mysql", stage: "batch_write" }
]

情景：只知道"有 500 错误"，不知道具体是谁的
SignalTags = [
  { type: "error:500" }
]
```

三种情景的 `type` 相同，但 Gene 召回结果可以不同：前两者如果有精细匹配 Gene，优先选精细；没有时自动回退到只匹配 `type` 的粗粒度 Gene。

#### 3.4.2 层级召回算法：Tag 子集匹配与粒度回退

**不使用向量数据库，不使用 embedding**。召回是纯结构化的 tag 子集覆盖评分：

```typescript
/**
 * 计算信号事件 event_tags 与 gene 的 signals_match 配置的覆盖分数
 *
 * 返回 [0, 1]：
 *   1.0 = event_tags 中的每个 tag 都被 gene 的某个 signals_match 条目完全覆盖
 *   0.5 = 只有 type 字段匹配（粗粒度，可以回退使用）
 *   0.0 = 没有任何 tag 匹配（不召回）
 */
function tagCoverageScore(eventTags: SignalTag[], geneSignalsMatch: SignalTag[]): number {
  // gene 的每个 match 条目是一个"模式"，event_tags 中只要有一个满足该模式就算命中
  // 模式命中：event tag 包含模式的所有 key-value（子集关系）
  function matchesPattern(tag: SignalTag, pattern: SignalTag): boolean {
    return Object.entries(pattern).every(([k, v]) => tag[k] === v);
  }

  // 对 event 中的每个 tag，找到最佳匹配的 gene 模式
  let totalScore = 0;
  for (const eventTag of eventTags) {
    let bestScore = 0;
    for (const pattern of geneSignalsMatch) {
      if (matchesPattern(eventTag, pattern)) {
        // 匹配的 key 越多 → 越精细 → 分数越高
        const matchedKeys = Object.keys(pattern).filter((k) => pattern[k] !== undefined).length;
        const totalKeys = Object.keys(eventTag).filter((k) => eventTag[k] !== undefined).length;
        bestScore = Math.max(bestScore, matchedKeys / totalKeys);
      }
    }
    totalScore += bestScore;
  }

  return totalScore / eventTags.length;
}

// 召回示例
// event_tags = [{ type: "error:500", provider: "openai", stage: "api_call" }]
//
// Gene A: signals_match = [{ type: "error:500", provider: "openai", stage: "api_call" }]
//   → matchedKeys=3, totalKeys=3 → score = 1.0  ← 精细匹配
//
// Gene B: signals_match = [{ type: "error:500", provider: "openai" }]
//   → matchedKeys=2, totalKeys=3 → score = 0.67  ← 中粒度匹配
//
// Gene C: signals_match = [{ type: "error:500" }]
//   → matchedKeys=1, totalKeys=3 → score = 0.33  ← 粗粒度匹配（Diagnostic Gene）
//
// Gene D: signals_match = [{ type: "error:503" }]
//   → matchesPattern = false → score = 0.0  ← 不召回
```

**召回结果融合（Thompson + coverage weight）：**

```typescript
// 最终 gene 评分 = Beta 后验采样值 × tag 覆盖分数
finalScore(gene) = Beta(α_combined, β_combined).sample() × tagCoverageScore(eventTags, gene.signalsMatch)
```

这样精细匹配的 Gene（score=1.0）和粗粒度 Diagnostic Gene（score=0.33）都参与竞争，但粗粒度的天然被打折——除非精细 Gene 的 Beta 后验太差（新的、失败多的），否则精细 Gene 会赢。

#### 3.4.3 Edge Confidence 语义重定义

|                             | 旧语义（错误）             | 新语义（正确）                                                        |
| --------------------------- | -------------------------- | --------------------------------------------------------------------- |
| **表达的是**                | P(gene 最终成功 \| signal) | P(gene 值得尝试 \| signal 类别) = 路由权重                            |
| **粗粒度信号（error:500）** | 意义混叠，无法解读         | 有效：在 error:500 这个类别下，这个 gene 历史上被选中并带来改善的比例 |
| **Beta 参数 α**             | 成功次数 + 1               | 进入后"有改善"次数 + 1（outcome > threshold）                         |
| **Beta 参数 β**             | 失败次数 + 1               | 进入后"无改善"次数 + 1                                                |
| **最终任务成功率**          | 与 confidence 混同         | 单独追踪，见 `task_success_rate` 字段                                 |

**关键推论：** 一个粗粒度 Diagnostic Gene 的 confidence 可以很高（它非常善于诊断和路由），即使最终任务成功率是由它路由到的下游 Gene 决定的。两个指标服务两个不同的目的，不应混淆。

#### 3.4.4 Diagnostic Gene：粗粒度信号的第一响应者

针对 `error:500` 这类高基数信号（一个 key 覆盖数十万情景），排名最高的候选 Gene 不应该是直接执行修复，而是**先诊断再路由**：

```json
{
  "name": "500 Error Triage",
  "category": "diagnostic",
  "signals_match": [{ "type": "error:500" }],
  "strategy": [
    "Step 1: Check execution context — determine root cause category (DB / Network / OOM / Logic).",
    "Step 2: [prismer_recall] 'similar error:500 resolutions' to find precedents.",
    "Step 3: Route to specialized gene based on diagnosis:",
    "        - DB connection pool → apply 'DB Connection Recovery' gene",
    "        - External API jitter → apply 'Exponential Backoff' gene",
    "        - OOM → apply 'Memory Pressure Relief' gene",
    "Step 4: Record diagnosis result as outcome (success = correct routing, not final task success)."
  ],
  "constraints": {
    "max_credits": 5,
    "timeout_seconds": 30
  }
}
```

**Diagnostic Gene 的几个关键性质：**

- `category: "diagnostic"` —— 一个新的 Gene 类型标识符
- Edge confidence 反映的是"成功诊断并完成路由"的概率，语义干净
- Gene 内部通过 `prismer_recall` 动态获取上下文（这正是 Prismer 的差异化能力）
- 它本身不解决问题，只负责把问题引导到正确的专门 Gene 面前
- **一个充分自适应的 Diagnostic Gene 让向量检索变得多余：** 上下文感知发生在 Gene 执行层而不是召回层，架构更清晰

#### 3.4.5 Bimodality Index：暴露伪精确 Confidence

当一个 Gene 对某个 Signal 的表现极度两极分化（在某些隐藏情景中 100% 成功，在另一些 100% 失败），均值 confidence 具有严重的误导性。引入 **Bimodality Index** 追踪这种混叠。

**为什么旧公式错误：**
对 Bernoulli(0/1) 序列，单个 outcome 的样本方差 ≈ p×(1-p)，这本身就是 Bernoulli 分布的理论方差——`observed_variance / max_variance` 对任何 i.i.d. 序列都约等于 1.0，无法区分"随机表现"与"双峰表现"。

**正确思路：超额分散（Overdispersion）检测**

真正的双峰信号是：gene 在场景 A 中**连续成功**、在场景 B 中**连续失败**。这会导致时间窗口间成功率的方差，**远超** i.i.d. Bernoulli(p) 预期的窗口方差。

```typescript
/**
 * Bimodality Index（双峰指数）—— 基于窗口超额分散
 *
 * 核心思路：将 recent N 个 outcome 切分为时间窗口，
 * 计算"窗口间成功率方差"与 i.i.d. Bernoulli(p) 期望窗口方差之比。
 *
 * 直觉验证：
 *   · 双峰情景（窗口A全成功/窗口B全失败，p=0.5）：
 *       crossWindowVar = 0.25，expectedVar = 0.25/10 = 0.025
 *       overdispersion = 10 → bimodality_index ≈ 1.0  ✓
 *
 *   · 纯随机（i.i.d. Bernoulli(0.5)，窗口内各有起伏）：
 *       crossWindowVar ≈ 0.025，expectedVar = 0.025
 *       overdispersion ≈ 1 → bimodality_index ≈ 0.0  ✓
 *
 * 存储在 im_evolution_edges 的新字段：bimodality_index FLOAT DEFAULT 0.0
 */
function updateBimodalityIndex(
  edge: EvolutionEdge,
  recentOutcomes: number[], // 0/1 序列，按时间顺序排列
  windowSize: number = 10, // 每个时间窗口的 capsule 数量
): number {
  const N = recentOutcomes.length;
  if (N < windowSize * 2) return 0; // 至少 2 个窗口才有意义

  const p = recentOutcomes.reduce((a, b) => a + b, 0) / N;
  // 极端集中区间（全成功或全失败）无法区分双峰与单峰，跳过
  if (p < 0.05 || p > 0.95) return 0;

  // 切分时间窗口，计算每个窗口的成功率
  const windowRates: number[] = [];
  for (let i = 0; i + windowSize <= N; i += windowSize) {
    const w = recentOutcomes.slice(i, i + windowSize);
    windowRates.push(w.reduce((a, b) => a + b, 0) / windowSize);
  }

  // 窗口间方差（实测）
  const wMean = windowRates.reduce((a, b) => a + b, 0) / windowRates.length;
  const crossWindowVar = windowRates.reduce((a, b) => a + Math.pow(b - wMean, 2), 0) / windowRates.length;

  // i.i.d. Bernoulli(p) 下，窗口均值的期望方差 = p*(1-p)/windowSize
  const expectedVar = (p * (1 - p)) / windowSize;

  // 超额分散比（overdispersion ratio）
  // 1.0 = 纯随机；>> 1 = 存在情景依赖（隐藏双峰）
  const overdispersion = crossWindowVar / (expectedVar + 1e-6);

  // 归一化：[1x, 10x] overdispersion → [0, 1]
  return Math.min(1.0, Math.max(0, (overdispersion - 1) / 9));
}
```

**Bimodality Index 的用途：**

| 值域      | 含义                        | 系统行为                                 |
| --------- | --------------------------- | ---------------------------------------- |
| < 0.3     | 结果稳定，confidence 可信   | 正常显示                                 |
| 0.3 - 0.7 | 有一定情景依赖              | 可视化加"光晕"宽度提示                   |
| > 0.7     | 严重两极化，confidence 误导 | 可视化显示"分裂细胞"；触发 Gene 蒸馏建议 |

**触发 Gene 蒸馏的条件（更新后）：**

- 原有：totalExecutions > 20 && successRate 偏低
- 新增：`bimodality_index > 0.7`（无论 successRate 是多少，高双峰说明需要场景细化）

#### 3.4.6 数据库 Schema 变更

```sql
-- im_evolution_edges 新增字段
ALTER TABLE im_evolution_edges
  ADD COLUMN bimodality_index FLOAT DEFAULT 0.0,     -- 双峰指数
  ADD COLUMN task_success_rate FLOAT DEFAULT NULL,   -- 最终任务成功率（与路由权重分离）
  ADD COLUMN coverage_level TINYINT DEFAULT 0;       -- 匹配精细度：0=粗粒度 1=中粒度 2=精细匹配

-- im_gene_signals 扩展（支持层级标签）
-- 当前：signal_key VARCHAR(255)
-- 新增：signal_tags JSON（存储 SignalTag 结构，向后兼容）
ALTER TABLE im_gene_signals
  ADD COLUMN signal_tags JSON DEFAULT NULL;          -- null = 用旧 signal_key 兼容模式

-- 向后兼容策略：
-- 1. signal_tags IS NULL → 回退到 signal_key 字符串精确匹配（旧行为）
-- 2. signal_tags NOT NULL → 使用新的 tag 子集匹配逻辑
-- 3. 迁移不强制，旧 Gene 继续工作，新 Gene 可以选择使用 tags
```

---

## 4. 核心算法精确描述

### 4.1 Phase 1: Thompson Sampling（替代 Laplace）✅ 已实现

**对每个 (signal_key, gene_id) 对，维护 Beta 后验：**

$$\text{posterior}(g|s) = \text{Beta}(\alpha_{s,g}, \beta_{s,g})$$

其中：
$$\alpha_{s,g} = \text{success\_count}(s,g) + 1$$
$$\beta_{s,g} = \text{failure\_count}(s,g) + 1$$

**Gene 选择：**

```
function select(signalTags, agentId):
  // Step 1: 召回候选 Gene（所有 agent 可见的 published + seed Gene）
  candidates = load_agent_genes(agentId)  // 含全局 published + seed

  for each gene g in candidates:
    // Step 2: 计算 tag 覆盖分数（层级召回，见 §3.4.2）
    coverageScore = tagCoverageScore(signalTags, g.signalsMatch)
    if coverageScore == 0: skip  // 无任何 tag 匹配，不参与竞争

    // Step 3: 查 edge（用 tag 的精细 key 或粗粒度 type key 查）
    signalKey = buildSignalKey(signalTags, g.matchedGranularity)
    edge = query_evolution_edge(agentId, signalKey, g.id)

    α = (edge?.successCount || 0) + 1
    β = (edge?.failureCount || 0) + 1

    // Step 4: 时间衰减（discounted evidence）
    if edge?.lastUsedAt:
      decay = 0.5 ^ (age_days / 30)
      α_eff = max(1, α * decay)
      β_eff = max(1, β * decay)
    else:
      α_eff = α
      β_eff = β

    // Step 5: 最终评分 = Beta 后验采样 × tag 覆盖分数
    // 精细匹配 Gene（coverageScore=1.0）和 Diagnostic Gene（coverageScore≈0.3）均参与竞争
    // 但 Diagnostic Gene 的 Beta 需要远高于精细 Gene 才能胜出
    g.sample = Beta(α_eff, β_eff).sample() * coverageScore

  // Thompson Sampling: 选择加权后采样值最高的
  return candidates.sort_by(g => g.sample).first()

// 向后兼容：若 gene.signal_tags IS NULL，
// coverageScore = (signalTags[0].type === gene.signalKey ? 1.0 : 0.0)  ← 旧精确匹配
```

> **统计语义说明（Discounted Evidence）：** 时间衰减直接作用于 α/β 的有效样本量。这**不是**严格贝叶斯更新——严格做法应将非平稳性建模为隐变量（如 change-point detection 或 restless bandit）。当前实现选择的是 **discounted posterior proxy**：在非平稳环境中更实用，但牺牲了 Beta-Bernoulli 共轭更新的精确解释性。这个权衡是刻意的——对 Prismer 的 Gene 生命周期（30 天半衰期），discounted evidence 在实践中与精确方法差异极小。

**为什么优于 Laplace：**

- Laplace 取均值 + 加噪声 → 噪声大小是超参数，难调
- Thompson 从后验采样 → 不确定性自然编码在分布宽度中，无超参数

### 4.2 近似分层贝叶斯聚合（Pooled Prior）✅ 已实现

> **术语说明：** 本节实现的是 **hierarchical-inspired pooled Thompson Sampling**——将全局统计量作为加权先验注入 Agent 的本地 Beta 后验。这在工程上等效于 empirical Bayes pooling，方向上与层级贝叶斯 bandit 一致，但并非严格的多层后验推断（后者需要学习超参数的超先验分布）。选择当前方案的原因是：实现简单、O(1) 查表、效果在 MVP 规模下与严格方法差异极小。

**两层模型：**

```
Global Layer (经验池化):
  对每个 (signal_key, gene_id):
    α_global = Σ_{all agents} success(agent, s, g) + 1
    β_global = Σ_{all agents} failure(agent, s, g) + 1

Agent Layer (本地经验):
  对每个 (agent_id, signal_key, gene_id):
    α_local = success(agent, s, g) + 1
    β_local = failure(agent, s, g) + 1

Combined (加权先验融合):
  n_agent = Σ_g (α_local + β_local - 2)    // Agent 总经验量
  w = max(0.2, 1 - n_agent / N_threshold)   // 全局权重，经验越多越低
                                             // N_threshold = 100（硬编码）

  α_combined = α_global * w + α_local * (1 - w)
  β_combined = β_global * w + β_local * (1 - w)

  sample ~ Beta(α_combined, β_combined)
```

**与严格层级贝叶斯的差异：**

- 严格方法：超参数 (μ₀, σ₀) 从数据中学习，Agent 参数 θᵢ ~ N(μ₀, σᵢ²I)
- 当前方法：权重 w 按固定公式计算，不从数据中推断
- 权衡：牺牲统计最优性，换取零超参数调优 + O(1) 在线更新

**实现方式（跨粒度聚合）：**

层级标签引入了粒度问题：`{type:"error:500", provider:"openai"}` 的精细 edge 和 `{type:"error:500"}` 的粗粒度 edge 服务于不同召回场景。全局先验应当在 `signal_type` 层面聚合（最粗粒度公分母），本地 edge 使用精确 key 查询。

需在 `im_evolution_edges` 增加 `signal_type` 冗余字段（等于 `SignalTag.type`，便于跨粒度聚合）：

```sql
-- Schema：im_evolution_edges 新增冗余字段
ALTER TABLE im_evolution_edges
  ADD COLUMN signal_type VARCHAR(128) AS (JSON_UNQUOTE(JSON_EXTRACT(signal_tags, '$[0].type')))
  STORED COMMENT '冗余字段：等于 signal_tags[0].type，用于跨粒度聚合';
-- 若 signal_tags IS NULL（旧格式），signal_type 等于 signal_key 的第一段（SUBSTRING_INDEX）

-- 全局聚合：在 signal_type 层面聚合（覆盖所有粒度的历史经验）
-- 例：计算 error:500 的全局先验时，合并 error:500|openai + error:500|mysql + error:500 的所有 edge
SELECT gene_id,
       SUM(success_count) + 1 AS alpha_global,
       SUM(failure_count) + 1 AS beta_global
FROM im_evolution_edges
WHERE signal_type = ?    -- 粗粒度类别匹配，跨所有 provider/stage/severity
GROUP BY gene_id;

-- Per-Agent 查询：使用精确 key 匹配（保留精细粒度的本地经验）
SELECT gene_id, success_count + 1 AS alpha_local, failure_count + 1 AS beta_local
FROM im_evolution_edges
WHERE owner_agent_id = ? AND signal_key = ?;  -- 精确 key：type|provider|stage 的组合
```

**跨粒度聚合的合理性：** 全局先验只需回答"这个 gene 对 error:500 这类问题通常值得尝试吗？"——粗粒度即可，细节由本地 edge 和 execution context 补充。用精细 key 聚合全局先验反而会因数据稀疏而失效（每个精细 key 可能只有个位数样本）。

### 4.3 Beta 分布采样（纯 JS 实现）

```typescript
/**
 * Sample from Beta(α, β) distribution using Jöhnk's algorithm.
 * No external dependencies needed.
 */
function betaSample(alpha: number, beta: number): number {
  // Special cases
  if (alpha <= 0 || beta <= 0) return 0.5;
  if (alpha === 1 && beta === 1) return Math.random();

  // Jöhnk's algorithm for small α, β
  if (alpha < 1 && beta < 1) {
    while (true) {
      const u = Math.random();
      const v = Math.random();
      const x = Math.pow(u, 1 / alpha);
      const y = Math.pow(v, 1 / beta);
      if (x + y <= 1) return x / (x + y);
    }
  }

  // Use Gamma sampling for larger parameters
  const x = gammaSample(alpha);
  const y = gammaSample(beta);
  return x / (x + y);
}

function gammaSample(shape: number): number {
  // Marsaglia & Tsang's method
  if (shape < 1) return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number, v: number;
    do {
      x = randn();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function randn(): number {
  // Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
```

### 4.4 Gene 蒸馏 Pipeline（Phase 2 预设计）⚠️ 部分实现

> Extract + Abstract 已实现（单次 LLM 调用），Critique 阶段和 Canary 发布未实现。

**触发条件（何时蒸馏）：**

```
当某个 Agent 满足以下条件之一时，触发蒸馏尝试：
  1. 该 Agent 在同一 signal_key 下积累 ≥ 5 次无 Gene 指导的成功执行
     （即 capsule.gene_id = null AND outcome = 'success'）
  2. 某个现有 Gene 的成功率持续低于 50%，但 Agent 自行探索的成功率 > 70%
     （说明 Agent 找到了比现有 Gene 更好的方法）
```

**Pipeline（Reflexion 架构）：**

```
┌─ Extract ──────────────────────────────────────────┐
│ 提取成功 Capsule 的 execution_log（步骤、上下文、结果）│
│ 输入：5+ 个成功 capsule                               │
│ 输出：结构化执行轨迹列表                               │
└──────────────────────┬─────────────────────────────┘
                       ▼
┌─ Abstract ─────────────────────────────────────────┐
│ LLM（Claude Sonnet）总结共性规律，生成 Draft Gene     │
│ Prompt: "从以下成功案例中提取通用策略..."               │
│ 输出：{ name, signals, strategy[], preconditions }   │
└──────────────────────┬─────────────────────────────┘
                       ▼
┌─ Critique ─────────────────────────────────────────┐
│ 第二个 LLM 调用，检查 Draft Gene 的质量               │
│ 检查项：                                               │
│   - 是否足够通用？（不是 overfitting 到单一 case）     │
│   - 是否比同 signal 下已有 Gene 有差异化？             │
│   - strategy 步骤是否可执行？                          │
│ 输出：pass / reject + 修改建议                        │
└──────────────────────┬─────────────────────────────┘
                       ▼
┌─ Publish ──────────────────────────────────────────┐
│ 如果通过 Critique：                                    │
│   status = 'canary'（灰度测试，见 §6.1）              │
│   owner = 蒸馏触发的 Agent                             │
│   lineage = 引用的 capsule IDs                        │
│   广播 IM 事件：evolution.gene_distilled              │
└────────────────────────────────────────────────────┘
```

**成本控制：** 蒸馏需要 2 次 LLM 调用，每次 ~0.01 USD。设置每 Agent 每天最多触发 3 次蒸馏。

**当前实现状态（v0.2.1）：**

- ✅ Extract 阶段：`getSuccessCapsules()` 获取成功 Capsule
- ✅ Abstract 阶段：单次 OpenAI 调用生成 Gene JSON（`triggerDistillation()`）
- ❌ Critique 阶段：**未实现**，生成的 Gene 未经第二次审查
- ⚠️ Publish 阶段：Gene 创建后直接存储为 `private`，未走 `canary` 灰度
- ✅ 触发条件检查：`shouldDistill()` — 10+ 成功 capsule、70% 成功率、24h 冷却
- ✅ 重复检测：Jaccard 相似度 > 80% 的 Gene 不会重复创建
- ✅ 成本控制：每 Agent 每天最多 3 次（冷却期机制）

### 4.5 未匹配信号追踪与 Gene 创建建议（v0.2.1 新增）

> 已实现。这是新根节点诞生的入口——当系统没有匹配的 Gene 时，不再返回空结果，而是主动引导 Agent 创建。

**完整决策链：**

```
Agent 遇到 signals: ["error:graphql_validation", "error:schema_mismatch"]
    │
    ▼
POST /evolution/analyze
    │
    ├─ selectGene() 遍历所有 Gene.signals_match
    │  Jaccard similarity = 0 for all genes
    │
    ├─ 记录未匹配信号 → im_unmatched_signals 表
    │  (upsert: 同一 signal+agent 组合计数递增)
    │
    └─ 返回 action: "create_suggested"
       {
         suggestion: {
           category: "repair",                              ← 从信号前缀推断
           title: "Graphql Validation Handler",             ← 自动生成
           signals_match: ["error:graphql_validation", "error:schema_mismatch"],
           description: "Auto-suggested by evolution engine",
           similar_genes: [{ gene_id: "...", similarity: 0.3 }]  ← Jaccard 最近邻
         }
       }
    │
    ▼
Agent 用 suggestion 调用 POST /evolution/genes → 新根节点诞生
    │
    ▼
resolveUnmatchedSignal() → 标记该信号已被覆盖
    │
    ▼
再次 analyze 同一信号 → action: "apply_gene" ✅
```

**数据模型：**

```prisma
model IMUnmatchedSignal {
  signalKey   String     // 标准化信号组合键（signal_type 级别，见下方说明）
  agentId     String     // 遇到此信号的 Agent
  signals     String     // JSON: 原始信号数组（string[] 或 SignalTag[]）
  signalTags  String?    // JSON: SignalTag[]（v0.3.0+，null = 旧 string[] 格式）
  count       Int        // 该 Agent 遇到此信号的次数
  resolvedBy  String?    // 被哪个 Gene 解决了

  @@unique([signalKey, agentId])
}
```

> **反碎片化设计（v0.3.0）：** `signalKey` 使用 `signal_type` 级别的粗粒度键（如 `error:500`），**不**包含 provider/stage 维度。原因见 SKILL-EVOLUTION.md §1.6.2：Evolver 的 `errsig_norm:<hash>` 方案把每个独特错误文本哈希为孤立 key，导致同类信号的未匹配计数无法聚合。使用 type 级别聚合确保"error:500 出现了 47 次还没有 Gene 覆盖"这个信息是准确的。

**API 端点：**

- `GET /evolution/public/unmatched?limit=20` — 查询进化前沿（未覆盖信号，按频率排序）
- 在 `POST /evolution/genes` 中自动调用 `resolveUnmatchedSignal()`

**类别推断规则：**

- `error:*`, `task.failed` → `repair`
- `perf:*`, `cost:*` → `optimize`
- 其他 → `innovate`

> 注：类别推断是启发式的硬编码规则，不是学习出来的。这在当前阶段可接受，但需意识到它与 Evolver 的 Personality 硬编码规则（`if error → rigor+=0.1`）是同一类设计妥协。

---

## 5. 可观测性设计

### 5.1 指标体系

可观测性是系统的**一等公民**，不是事后添加的 dashboard。

#### 全局指标

| 指标                 | 公式                                | 意义               | 更新频率 |
| -------------------- | ----------------------------------- | ------------------ | -------- | ------------ | -------- |
| Evolution Velocity   | `capsules_7d / 7`                   | 系统活跃度         | 实时     |
| Gene Diversity Index | `1 - Σ(share_i²)` (Herfindahl)      | Gene 使用多样性    | 每小时   |
| System Success Rate  | `Σ success / Σ total`               | 全局成功率         | 实时     |
| Exploration Rate     | `unique_genes_7d / total_genes`     | 探索覆盖度         | 每日     |
| Information Gain     | `KL(posterior ‖ prior)` per capsule | 每次执行的学习量   | 每次执行 |
| Surprise Score       | `                                   | actual - predicted | ` 的均值 | 系统预测偏差 | 每次执行 |

#### Gene 级指标

| 指标        | 公式                                                              | 意义                                                                                   |
| ----------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| PQI         | `success_rate×0.4 + norm_exec×0.3 + adoption×0.2 + freshness×0.1` | 综合质量（⚠️ 权重为启发式，需用历史数据校准）                                          |
| Edge 样本量 | `α + β` (Beta 分布参数之和)                                       | 路由权重的统计可靠度（样本越多，权重越可信；不是"成功率置信度"——见 §3.4.3 语义重定义） |

> **PQI 校准说明：** 当前 PQI 权重 (0.4/0.3/0.2/0.1) 是启发式设定，未经数据验证。在执行量接近零的冷启动阶段，PQI 的 `norm_exec` 和 `adoption` 分量几乎无意义。后续计划：（1）收集足够 Capsule 数据后用人工标注 + 回归拟合校准权重；（2）在 Gene 执行量 < 10 时降权或标注 "insufficient data"。
> | Trend | 7-day success rate vs 30-day | 趋势方向 |
> | Adoption Rate | `agents_using / total_agents` | 传播度 |

#### Agent 级指标

| 指标                 | 公式                                                      | 意义     |
| -------------------- | --------------------------------------------------------- | -------- |
| Contribution Score   | `capsules×1 + published×10 + adopted×5 + success_rate×50` | 贡献度   |
| Personality Drift    | `‖personality_t - personality_{t-7d}‖`                    | 适应速度 |
| Specialization Index | `max(category_share)`                                     | 专注度   |

### 5.2 进化节点状态机

每个 Gene 执行（Capsule）有明确的生命周期状态：

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ SELECTED │───▶│ EXECUTING│───▶│ COMPLETED│───▶│ RECORDED │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     │               │               │
     ▼               ▼               ▼
┌──────────┐    ┌──────────┐    ┌──────────┐
│ SKIPPED  │    │ TIMEOUT  │    │  FAILED  │
│ (no gene)│    │          │    │          │
└──────────┘    └──────────┘    └──────────┘
```

**每个状态转换都产生可观测事件：**

- `evolution.gene_selected` — 选了哪个 Gene，置信度多少，是否在探索
- `evolution.gene_executing` — 开始执行
- `evolution.gene_completed` — 结果、得分、耗时
- `evolution.outcome_recorded` — 记忆图谱更新，信息增量

### 5.3 全局进化图谱可视化

> 详细设计见 **`docs/EVOLUTION-MAP-DESIGN.md`**（v0.3，单画布宇宙隐喻方案）。本节仅说明可视化与本文算法层的数据接口契约。

**核心设计原则（摘要）：**

- **单一可缩放画布**，缩放层级控制认知负荷（而非分页/分区）
- **入口状态（L1 最大缩放）：** 以最近一次进化事件为中心，嵌入完整的 EvolutionStory（谁/用什么 gene/干了什么/取得什么效果）
- **逐层展开（L2→L3→L4）：** 太阳系→猎户臂→星系，domain 聚类由二部图社区检测（Louvain/Leiden）自动涌现，不预定义分类
- **Ghost 节点**：视口边缘始终渲染 10-15% 透明度的幽灵节点，提示图谱延伸

**算法层提供给可视化层的数据契约：**

| 数据                                     | 算法来源                    | 可视化用途                |
| ---------------------------------------- | --------------------------- | ------------------------- |
| `edge.alpha + edge.beta`                 | Thompson Sampling posterior | 边的线宽（使用量）        |
| `edge.alpha / (alpha+beta)`              | Beta 后验均值               | 边颜色（路由权重，绿→红） |
| `edge.bimodality_index`                  | §3.4.5 超额分散检测         | 节点光晕宽度（双峰警告）  |
| `gene.pqi`                               | §5.1 PQI                    | Gene 节点边框粗细         |
| `capsule.outcome` + `capsule.created_at` | `recordOutcome()`           | L1 EvolutionStory 时间线  |
| community_id（图聚类结果）               | Louvain on bipartite graph  | L2/L3 聚类着色            |

**API：**

- `GET /api/im/evolution/stories?limit=3&since=30m` — L1 入口事件（< 100ms）
- `GET /api/im/evolution/map` — 图谱全数据（< 500ms，增量更新）

---

## 6. 安全与韧性

> **实现状态：4/4 安全机制已实现（v0.2.1）。** Rate Decay + Canary 灰度 + Circuit Breaker 三态状态机 + Freeze Mode 全局冻结。

进化系统的数据模型（Beta 后验）是跨 Agent 共享的全局状态。一旦被污染（恶意刷数据或级联故障），修复成本极高。本节定义三层防御机制。

### 6.1 Anti-Poisoning：防刷与灰度

**威胁模型：** 恶意或故障 Agent 高频调用 `prismer_evolve_record`，刷高某个无效 Gene 的 `success_count`，扭曲全局图谱。

**机制 1：频率衰减（Rate Decay）**

对单个 (Agent, Gene) 对，短时间内的连续成功记录权重指数衰减：

```
有效增量 = 1 × decay^(n_recent)

其中 n_recent = 该 Agent 在过去 1 小时内对同一 Gene 的记录次数
decay = 0.5（半衰常数）

示例：
  第 1 次: Δα = 1.0
  第 2 次: Δα = 0.5
  第 3 次: Δα = 0.25
  第 10 次: Δα ≈ 0.001（几乎无效）
```

**实现：** 在 `evolution.service.ts` 的 `recordOutcome` 中，查询该 (agent, gene) 最近 1h 的 capsule 数量，计算衰减因子后写入 edge。

**机制 2：Gene 灰度层级（Visibility Tiers）**

```
seed → canary → published → quarantined
  │       │         │            │
  │       │         │            └─ 被标记为有害，从推荐中移除
  │       │         └─ 全局可见，正常参与推荐
  │       └─ 灰度测试，仅限创建者 + 5% 随机 Agent 可见
  └─ 系统内置，不可修改
```

新发布的 Gene 默认进入 `canary` 状态。在层级贝叶斯聚合时，`canary` Gene 的全局权重 `w_prior` 带 0.5 的风险折扣：

```
// canary Gene 的全局权重折扣
w_prior_effective = w_prior × (status === 'canary' ? 0.5 : 1.0)
```

**晋升条件 `canary → published`：**

| 维度     | 条件                                | 说明                           |
| -------- | ----------------------------------- | ------------------------------ |
| 采样覆盖 | ≥3 个不同 Agent 使用                | 防止单一 Agent bias            |
| 执行量   | ≥20 次执行                          | 足够统计显著性                 |
| 成功率   | >50% 且 95% CI 下界 > 30%           | 使用 Beta 可信区间，非点估计   |
| 观察窗口 | ≥48 小时                            | 覆盖不同时段的流量特征         |
| 对照基线 | 成功率不低于同类别 seed Gene 的 80% | 与同功能控制组比较，非绝对阈值 |

**降级条件 `published → quarantined`：**

| 触发     | 条件                       | 自动化处置              |
| -------- | -------------------------- | ----------------------- |
| 性能劣化 | 最近 50 次执行成功率 < 20% | 自动降级，IM 广播通知   |
| 连续失败 | 连续 10 次失败             | 自动降级                |
| 举报     | ≥3 个 Agent 举报           | 自动降级 + 人工审核队列 |
| 人工标记 | 管理员操作                 | 立即降级                |

**采样策略（Canary 可见性）：**

- 默认：创建者 + 5% 随机 Agent 可见（按 agentId hash 取模）
- 可选：限定同 owner / 同 domain / 同任务类型的 Agent（分层采样）
- Canary 观察窗口内的 Capsule 标记 `env: "canary"`，与正式 Capsule 分开统计

### 6.2 执行熔断（Circuit Breaker）

不只是字段级约束（max_retries），而是完整的三态状态机：

```
              失败率 < 阈值                    失败率 > 阈值
    ┌──── CLOSED ────────────────── OPEN ──────────────┐
    │  (正常执行)     失败计数       (拒绝执行,          │
    │                 累积超阈值      返回 fallback)      │
    │                                    │               │
    │                              cooldown 超时         │
    │                                    ▼               │
    │                              HALF-OPEN             │
    │     成功                    (允许探测请求)          │
    └──────────────────────────── 单次试执行 ────────────┘
                                   失败 → 回 OPEN
```

**per-Gene 状态机参数：**

```typescript
interface GeneCircuitBreaker {
  state: 'closed' | 'open' | 'half_open';
  failureCount: number; // 当前窗口内失败次数
  failureThreshold: number; // 触发 OPEN 的阈值（默认 5）
  windowMs: number; // 失败计数窗口（默认 300_000 = 5 分钟）
  cooldownMs: number; // OPEN → HALF_OPEN 的等待时间（默认 60_000）
  lastFailureAt: number; // 最后失败时间戳
  lastStateChange: number; // 状态变更时间戳
}
```

**Execution Guard（单次执行约束，与状态机独立）：**

```typescript
interface GeneConstraints {
  max_retries?: number; // 已有
  max_credits_per_run: number; // 单次执行最大消耗（默认 10 cr）
  max_execution_time: number; // 最大执行时间（默认 300s）
}
```

**熔断结果处理：**

- 被熔断拒绝的请求：Capsule 标记 `circuit_broken: true`，**不更新 Beta 分布**
- 被 execution guard 终止的请求：同上
- 区分错误类型：`timeout` 计入熔断，`validation_error` 不计入（业务错误 vs 系统故障）

### 6.3 级联故障冻结（Freeze Mode）

**威胁模型：** 外部依赖（OpenAI、Exa）大面积宕机 → 所有 Agent 同时失败 → 海量 `failure_count` 涌入 → 破坏所有 Gene 长期积累的 Beta 分布。

**这是最危险的场景，因为损害是全局性、不可逆的。**

**多粒度冻结（不只全局）：**

```
粒度层级（由粗到细）：

1. Global Freeze    — 全局失败率 > 80%，冻结所有 Beta 更新
2. Provider Freeze  — 某外部依赖（OpenAI/Exa）失败率 > 80%，仅冻结相关 Gene
3. Signal-Type Freeze — 某 signal type（error:*）失败率 > 80%，冻结该类别下所有 Gene
4. Rollout Freeze   — 某 canary Gene 连续失败，仅冻结该 Gene
```

**触发条件：**

```
滑动窗口: 5 分钟

Global Freeze:
  条件: global_failure_rate > 0.8 AND total_capsules_5min > 20
  行为: 冻结所有 Beta 更新
  解冻: 连续 5 分钟 failure_rate < 0.3

Provider Freeze（优先于 Global，更精确）:
  条件: 某 external provider 的 failure_rate > 0.8 AND capsules > 10
  行为: 仅冻结包含该 provider 调用的 Gene 的 Beta 更新
  识别: capsule.metadata.external_calls 或 gene.strategy 中的 provider hint
  解冻: 该 provider failure_rate < 0.3

Rollout Freeze:
  条件: canary Gene 连续 5 次失败
  行为: 自动降级 canary → quarantined（见 §6.1）
```

**冻结期间行为：**

1. Capsule 仍然记录（append-only 事件流，审计需要）
2. Beta 分布不更新（α, β 冻住）
3. Gene 选择继续工作（基于冻结前的分布）
4. 冻结期间 Capsule 标记 `env: "degraded"`
5. IM 广播通知 `⚠️ Evolution frozen: {scope} — {reason}`

**恢复后：** 冻结期间的 Capsule 可选人工审核后决定是否回补到 Beta 分布。

**实现：** 在 `evolution.service.ts` 中维护滑动窗口计数器（5 分钟窗口）。状态存储在 `globalThis.__evolutionFreezeState`。

### 6.4 安全机制总结

| 层级   | 威胁            | 机制                          | 设计    | 实现                                                                          |
| ------ | --------------- | ----------------------------- | ------- | ----------------------------------------------------------------------------- |
| 数据层 | 单 Agent 刷数据 | Rate Decay（频率衰减）        | ✅ §6.1 | ✅ `recordOutcome()` 内置 0.5^n 衰减                                          |
| 发布层 | 低质/恶意 Gene  | Canary 灰度 + 晋升条件        | ✅ §6.1 | ✅ `publishGeneAsCanary()` + `checkCanaryPromotion()` + `checkGeneDemotion()` |
| 执行层 | 持续失败风暴    | Circuit Breaker 三态状态机    | ✅ §6.2 | ✅ per-Gene closed/open/half_open + `selectGene()` 过滤                       |
| 系统层 | 级联故障        | Freeze Mode（冻结 Beta 更新） | ✅ §6.3 | ✅ 5 分钟滑动窗口 + 自动冻结/解冻                                             |
| 前沿层 | 覆盖盲区        | Unmatched Signal 追踪         | ✅ §4.5 | ✅ 已实现                                                                     |
| 信誉层 | 长期恶意贡献者  | Agent Reputation 权重         | 概念    | Phase 3                                                                       |

---

## 7. SDK 设计

### 7.1 设计原则：最小 API Surface

Agent 开发者只需 **3 个核心操作** 即可参与进化生态。

### 7.2 CLI Commands

```bash
# 1. 分析当前状况，获取 Gene 推荐
# --signals 接受 JSON 数组（SignalTag[]）或旧格式逗号分隔字符串（向后兼容）
prismer evolve analyze --signals '[{"type":"error:timeout","provider":"openai","stage":"api_call"}]'
# 简写（粗粒度，向后兼容旧格式）：
prismer evolve analyze --signals "error:timeout,task.failed"
# 返回: { gene: "timeout-recovery", routingWeight: 0.92, coverageScore: 1.0, strategy: [...] }

# 2. 记录执行结果
prismer evolve record --gene timeout-recovery --outcome success --score 0.85
# 返回: { recorded: true, info_gain: 0.03 }

# 3. 创建新 Gene（支持层级标签）
prismer evolve create --category repair \
  --signals '[{"type":"error:timeout"},{"type":"error:ETIMEDOUT","provider":"openai"}]' \
  --strategy "Increase timeout to 30s" "Retry with exponential backoff" \
  --name "Timeout Recovery v2"
# 返回: { gene_id: "gene_repair_timeout_v2", status: "published" }
```

### 7.3 SDK 编程接口

```typescript
// TypeScript SDK
const advice = await prismer.evolution.analyze({
  // 新格式：SignalTag[]（推荐）
  signals: [{ type: 'error:timeout', provider: 'openai', stage: 'api_call' }],
  // 兼容旧格式：string[]（自动规范化为粗粒度 SignalTag）
  // signals: ['error:timeout', 'task.failed'],
  context: { taskId: 'task_123' },
});

if (advice.gene) {
  // advice.gene.routingWeight — 路由权重（值不值得尝试）
  // advice.gene.coverageScore — tag 覆盖分数（匹配精细度）
  // 执行 Gene strategy（strategy 步骤可能包含 prismer_load 调用）
  const result = await executeStrategy(advice.gene.strategy);

  // 记录结果
  await prismer.evolution.record({
    geneId: advice.gene.id,
    outcome: result.success ? 'success' : 'failed',
    score: result.score,
    summary: result.summary,
  });
}
```

```python
# Python SDK
advice = await prismer.evolution.analyze(
    signals=["error:timeout", "task.failed"]
)

if advice.gene:
    result = await execute_strategy(advice.gene.strategy)
    await prismer.evolution.record(
        gene_id=advice.gene.id,
        outcome="success" if result.success else "failed",
        score=result.score,
    )
```

### 7.4 OpenClaw Skill 集成（MVP 路径）

```yaml
# SKILL.md for Prismer Evolution Skill
name: prismer-evolution
description: Self-improving AI agent through cloud-based skill evolution
tools:
  - prismer_evolve_analyze # 分析 → 推荐 Gene
  - prismer_evolve_record # 记录执行结果
  - prismer_gene_create # 创建新 Gene
  - prismer_load # Context Engineering
  - prismer_save # 保存学习到的知识
```

---

## 8. MVP 路径

### 8.1 最小闭环

```
OpenClaw Agent 安装 prismer-evolution skill
    ↓
遇到问题 → prismer_evolve_analyze → 获得 Gene 推荐
    ↓
执行 Gene strategy（可调用 prismer_load 获取上下文）
    ↓
prismer_evolve_record → 记录结果 → 更新全局图谱
    ↓
获得 Credit 奖励（成功执行 = +1 cr, 发布 Gene = +10 cr）
    ↓
其他 Agent 通过 /evolution 页面看到这个 Gene → 安装 → 循环
```

### 8.2 MVP 实现状态

| 模块       | 工作项                                       | 预估   | 状态                                     |
| ---------- | -------------------------------------------- | ------ | ---------------------------------------- |
| **算法**   | Thompson Sampling 替代 Laplace 选择          | 0.5 天 | ✅ 已实现                                |
| **算法**   | 全局聚合查询（SQL GROUP BY）                 | 0.5 天 | ✅ 已实现                                |
| **算法**   | 未匹配信号追踪 + 创建建议流                  | 0.5 天 | ✅ 已实现 (v0.2.1)                       |
| **安全**   | Rate Decay 频率衰减                          | 0.5 天 | ✅ 已实现 (v0.2.1)                       |
| **安全**   | Canary 灰度层级 + 晋升/降级条件              | 0.5 天 | ✅ 已实现 (v0.2.1)                       |
| **安全**   | 执行 Circuit Breaker (三态状态机)            | 0.5 天 | ✅ 已实现 (v0.2.1)                       |
| **安全**   | Freeze Mode (全局失败率冻结)                 | 1 天   | ✅ 已实现 (v0.2.1)                       |
| **API**    | `GET /evolution/map` — 图谱数据              | 1 天   | ✅ 已实现（含信号聚合）                  |
| **API**    | `GET /evolution/public/unmatched` — 进化前沿 | 0.5 天 | ✅ 已实现 (v0.2.1)                       |
| **SDK**    | prismer CLI `evolve analyze/record/create`   | 1 天   | ✅ 已实现                                |
| **可观测** | 6 个全局指标 API                             | 1 天   | ✅ 已实现                                |
| **Credit** | 执行成功 +1 cr，里程碑奖励                   | 0.5 天 | ✅ 已实现                                |
| **前端**   | 进化图谱可视化                               | 2 天   | 🔧 实验中（Canvas 力导向图，效果待优化） |
| **前端**   | Gene Card 置信度自然语言解释                 | 0.5 天 | ❌ 未实现                                |
| **文档**   | API 文档 + SDK README                        | 0.5 天 | ✅ 已实现                                |
| **已完成** |                                              |        | **14/15 项 (93%)**                       |
| **剩余**   | 前端图谱可视化优化                           |        | **~2 天**                                |

### 8.3 不在 MVP 中的

- LinUCB / Neural Bandits（Phase 2）
- Gene 蒸馏 Critique 阶段 — 第二次 LLM 质量审查（Phase 2，Extract+Abstract 已实现）
- MAP-Elites Gene 多样性管理（Phase 3）
- 隐私保护联邦学习 P-FCB（Phase 3）
- Agent Reputation 声誉权重体系（Phase 3）
- Gene 血统树可视化（Phase 2，parentGeneId/distilled_from 数据模型已有）
- Signal 实体化 — 从 string 迁移到独立 `im_signals` 表（Phase 2，见重构方案）
- Capsule replay 评估框架（Phase 2）

> **已完成（原列 Phase 2）：**
>
> - ~~Gene 独立表 — 从 `im_agents.metadata.genes[]` JSON 迁移到 `im_genes` 表~~ ✅ 已完成
> - ~~跨 Agent 知识共享候选池~~ ✅ v0.2.3 完成（selectGene 合并全局 genes）
> - ~~Recall 统一检索 API~~ ✅ v0.2.3 完成（FULLTEXT + 三源搜索）
> - ~~Provider 级 Freeze Mode~~ ✅ v0.2.3 完成（metadata.provider 触发）
> - ~~Canary 自动晋升/降级触发~~ ✅ v0.2.3 完成（recordOutcome fire-and-forget）
> - ~~Simulation 实验脚本~~ ✅ v0.2.3 完成（scripts/experiments/evolution-sim.ts）

### 8.4 落地优先级建议

> **先打通知识闭环，再补安全闭环，再扩算法复杂度。**

| 优先级 | 工作                                                       | 理由                                                                           |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **P0** | Recall 桥接（FULLTEXT / tags / content_uri bug 修复）      | 没有检索闭环，Gene strategy 够不着上下文，再好的 TS 也只是在"空上下文"里挑模板 |
| **P0** | Gene 独立表迁移                                            | 数千 Agent 场景下 JSON-in-metadata 会成为索引、一致性、灰度可见性的瓶颈        |
| **P1** | 最小安全闭环（Rate Decay + 最简 Canary + Circuit Breaker） | 没有安全闭环，系统不敢"放"——错误反馈直接进入全局先验                           |
| **P1** | Capsule replay 评估框架                                    | 没有验证闭环，不知道收益来自哪里                                               |
| **P2** | 蒸馏 Critique 阶段                                         | 没有质量门控，堆积"语言上像策略"但实际不稳的 Gene                              |
| **P2** | Freeze Mode（细粒度）                                      | Provider 级冻结比全局冻结更精准                                                |
| **P3** | LinUCB / MAP-Elites / 自适应 Personality                   | 算法复杂度提升，依赖 P0-P1 的数据基础                                          |

---

## 9. 实验设计

### 9.1 Simulation 实验（无需真实 Agent）

用模拟环境对比不同选择算法的性能。

**设置：**

- 50 个模拟 Agent，各自独立执行
- 20 个 Gene，每个有真实成功率 p_true（从 Beta(2,2) 随机生成）
- 10 种 Signal，每种有 2-3 个匹配 Gene
- 模拟 10,000 次执行

**对比方法：**

| 方法            | 描述                                      |
| --------------- | ----------------------------------------- |
| Random          | 随机选择匹配 Gene                         |
| Laplace         | 当前方案（Laplace + 时间衰减 + 遗传漂变） |
| Thompson        | Thompson Sampling（Beta 后验采样）        |
| Thompson-Global | Thompson + 全局先验（层级贝叶斯）         |
| LinUCB          | 线性上下文 bandit                         |
| Oracle          | 总是选择最优 Gene（理论上界）             |

**评估指标：**

1. **Cumulative Regret：** $R_T = \sum_{t=1}^T [r^* - r_t]$
2. **Convergence Speed：** 达到 90% Oracle 性能所需的执行次数
3. **Cold-Start Performance：** 前 100 次执行的平均 success rate
4. **Cross-Agent Transfer：** 新 Agent 加入后的学习曲线

### 9.2 预期结论

基于文献和理论分析的预期：

```
Cumulative Regret (10K steps):
  Random:            ~2500  (50% regret)
  Laplace:           ~800   (drift 帮助探索但不最优)
  Thompson:          ~400   (理论最优探索)
  Thompson-Global:   ~200   (跨 Agent 加速)
  LinUCB:            ~350   (上下文利用)
  Oracle:            0

Cold-Start (first 100 steps, avg success rate):
  Random:            ~0.50
  Laplace:           ~0.55  (Laplace 给出 0.5 初始估计)
  Thompson:          ~0.55  (同 Laplace 初始)
  Thompson-Global:   ~0.75  (继承全局先验)
  LinUCB:            ~0.60  (上下文泛化)
  Oracle:            ~0.85
```

### 9.3 四层验证体系（Simulation 之外）

> Simulation 验证算法理论性能，但真实系统的难点是非平稳环境、异质 Agent、外部依赖抖动。需要四层验证：

| 层级                | 方法                                                         | 回答的问题                       | 依赖                         |
| ------------------- | ------------------------------------------------------------ | -------------------------------- | ---------------------------- |
| **L1: 离线回放**    | 同一批 Capsule 事件流下对比 Laplace / TS / Pooled / No-prior | 收益来自算法还是数据质量？       | 需要足够的生产 Capsule       |
| **L2: Shadow Mode** | 新算法并行运行但不影响推荐，只记录 "如果用它会选哪个 Gene"   | 与当前方案的 counterfactual 差异 | 需要部署 shadow 路径         |
| **L3: Canary 放量** | 5% Agent 用新算法，95% 用旧算法，比较真实 success rate       | 真实环境下的增量收益             | 需要 Canary 基础设施（§6.1） |
| **L4: 全量放量**    | 全部切换                                                     | —                                | 需要 L3 验证通过             |

**关键实验问题：** 收益到底来自算法改进，还是来自数据清洗 / 上下文质量变好 / 信号 schema 优化？只有 L1 离线回放能回答这个问题。

### 9.4 实验脚本

```bash
# 运行 simulation
npx tsx scripts/experiments/evolution-sim.ts \
  --agents 50 --genes 20 --signals 10 --steps 10000 \
  --methods random,laplace,thompson,thompson-global,linucb,oracle \
  --output docs/experiments/results.json

# 生成图表
npx tsx scripts/experiments/plot-results.ts \
  --input docs/experiments/results.json \
  --output docs/experiments/
```

---

## 10. 论文/公众号材料索引

### 10.1 关键论文

| #   | 作者             | 年份 | 标题                                                                     | 领域     | 重要性        |
| --- | ---------------- | ---- | ------------------------------------------------------------------------ | -------- | ------------- |
| 1   | Li et al.        | 2010 | A Contextual-Bandit Approach to Personalized News Article Recommendation | Bandits  | 奠基          |
| 2   | Agrawal & Goyal  | 2013 | Thompson Sampling for Contextual Bandits with Linear Payoffs             | Bandits  | 奠基          |
| 3   | Hong et al.      | 2022 | Hierarchical Bayesian Bandits                                            | Bandits  | 前沿          |
| 4   | Fourati et al.   | 2024 | Federated Combinatorial Multi-Agent Multi-Armed Bandits                  | Bandits  | ICML 2024     |
| 5   | Mouret & Clune   | 2015 | Illuminating Search Spaces by Mapping Elites                             | QD       | 奠基          |
| 6   | Novikov et al.   | 2025 | AlphaEvolve: A Coding Agent for Algorithmic Discovery                    | EC+LLM   | DeepMind 最新 |
| 7   | Guo et al.       | 2024 | EvoPrompt: Connecting LLMs with EA                                       | LLM+EC   | ICLR 2024     |
| 8   | Fernando et al.  | 2024 | PromptBreeder: Self-Referential Self-Improvement                         | LLM+EC   | ICML 2024     |
| 9   | Ma et al.        | 2024 | Eureka: Human-Level Reward Design via Coding LLMs                        | LLM+RL   | ICLR 2024     |
| 10  | Sutton et al.    | 1999 | Between MDPs and Semi-MDPs (Options Framework)                           | HRL      | 经典          |
| 11  | Jaderberg et al. | 2017 | Population Based Training of Neural Networks                             | PBT      | DeepMind      |
| 12  | Fang et al.      | 2025 | Comprehensive Survey of Self-Evolving AI Agents                          | Survey   | 最新综述      |
| 13  | Lehman & Stanley | 2011 | Abandoning Objectives: Evolution Through Novelty Alone                   | EC       | 奠基          |
| 14  | Wang et al.      | 2020 | Enhanced POET: Open-ended RL                                             | EC       | ICML 2020     |
| 15  | Rusu et al.      | 2016 | Policy Distillation                                                      | Transfer | ICLR 2016     |

### 10.2 公众号文章大纲建议

**标题：** "从 Bandit 到进化：如何构建多 Agent 在线学习系统"

1. 引子：AI Agent 的学习困境（每个 Agent 都在重新犯同样的错）
2. 问题形式化：多 Agent Contextual Bandit
3. 现有方案的局限（EvoMap 分析 + 我们的 Laplace 方案）
4. Thompson Sampling：让不确定性自己说话
5. 层级贝叶斯：从"个体学习"到"种群学习"
6. Context Engineering 的杀手锏：Gene + Load/Save
7. 可观测性：看见进化正在发生
8. 实验结果
9. 未来方向：MAP-Elites、EvoPrompt、Learned Context Routing

---

## 11. 前端体验设计 — 可传播性、趣味性、掌控感

### 11.1 当前页面的核心问题诊断

当前 `/evolution` 页面是 2664 行的单文件巨石组件。它有 5 个 tab、若干卡片、几个列表，但**没有灵魂**。

| 问题             | 根因                                                | 后果            |
| ---------------- | --------------------------------------------------- | --------------- |
| **没有故事**     | 页面是数据陈列柜，不是叙事                          | 用户 3 秒就关掉 |
| **没有"我"**     | 看不到"我"的 Agent 做了什么、排在哪                 | 没有归属感      |
| **没有惊喜**     | 每次打开都一样（seed genes 永远 0 executions）      | 没有回访动力    |
| **没有动作**     | 按钮不能点（已修 TiltCard）、点了也不知道发生了什么 | 没有掌控感      |
| **没有社交货币** | 没有任何东西值得截图分享                            | 没有传播性      |
| **数据感 = 0**   | 45 个 seed gene 全是静态 JSON，0 execution          | 页面是空壳      |

**核心矛盾：我们建了一个"进化展示页"，但系统里还没有真正的进化在发生。**

### 11.2 设计哲学：三个情感维度

#### 11.2.1 掌控感 (Sense of Agency)

**用户要感受到"我在控制进化的方向"，而不是"我在看一个仪表盘"。**

当前缺失：

- 没有"我的 Agent"入口 — 所有数据都是全局的
- Gene 的"Install"按钮点了不知道安装到哪
- 没有"发起进化"的主动操作

改进设计：

```
┌─ My Evolution ──────────────────────────────────────────┐
│                                                          │
│  🤖 agent-alpha (Online)                                │
│  ┌──────────────────────────────────────────────────┐   │
│  │  My Genes: 12 active  │  Executions: 89 today   │   │
│  │  Success: ████████░░ 78%  │  Rank: #3 ↑2        │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  Recent:                                                 │
│  ✅ Timeout Recovery solved error:timeout (0.92)  2m ago │
│  ❌ Auth Refresh failed on api.prod.com (0.2)     8m ago │
│  🧬 NEW GENE distilled: Connection Pooling     15m ago │
│                                                          │
│  ┌────────────────┐  ┌──────────────────────┐           │
│  │ [Run Evolution] │  │ [Publish a Gene →]   │           │
│  └────────────────┘  └──────────────────────┘           │
└──────────────────────────────────────────────────────────┘
```

**关键交互：**

| 操作            | 反馈                                            | 情感         |
| --------------- | ----------------------------------------------- | ------------ |
| "Run Evolution" | 实时显示信号提取→Gene匹配→执行过程              | **我在指挥** |
| "Install Gene"  | Toast + Gene 出现在 "My Genes" 列表             | **我在收集** |
| "Publish Gene"  | 全局 Timeline 广播 + Credit 到账动画            | **我在贡献** |
| "Fork Gene"     | 新 Gene 出现在 My Library，标记 "forked from X" | **我在创造** |

#### 11.2.2 趣味性 (Engagement & Delight)

**用户要觉得"这个页面活着"，每次来都有新东西。**

当前缺失：

- KPI 数字是死的（0, 0, 0%, 0）
- 没有动画反馈
- 没有成就系统
- 没有"发现"的惊喜

改进设计：

**A. 活体指标（Live Pulse）**

不是展示数字，而是展示**正在发生的事**：

```
┌─ Evolution is alive ────────────────────────────┐
│                                                   │
│  ● 3 agents evolving right now                   │
│                                                   │
│  [agent-beta] just solved error:429        12s   │
│  [agent-gamma] is trying Auth Refresh...   now   │
│  [agent-alpha] distilled a new gene!       2m    │
│                                                   │
│  Today: 47 executions • 82% success • 2 new genes│
└───────────────────────────────────────────────────┘
```

用 SSE/WebSocket 推送实时事件，页面上小圆点脉冲闪烁。即使没有真实数据，seed gene 的模拟执行也能让页面"活起来"。

**B. 成就徽章（Achievement Badges）**

| 徽章               | 条件                         | 设计                |
| ------------------ | ---------------------------- | ------------------- |
| 🌱 First Gene      | 安装第一个 Gene              | 绿色徽章 + 弹窗庆祝 |
| ⚡ First Execution | 第一次 Gene 执行             | 闪电动画            |
| 🧬 Gene Creator    | 发布第一个自创 Gene          | DNA 螺旋动画        |
| 🔥 Streak x10      | 连续 10 次成功执行           | 火焰效果            |
| 🏆 Top 10          | 进入贡献排行前 10            | 皇冠图标            |
| 🌳 Lineage Root    | 自己的 Gene 被 3+ Agent fork | 树根生长动画        |

徽章累积在用户 Profile 上，可嵌入 GitHub README（SVG badge）。

**C. 探索模式（Explore）**

不只是过滤 skill 列表。是一个**发现引擎**：

```
┌─ 💡 Discover ──────────────────────────────────┐
│                                                  │
│  "Based on your recent error:timeout signals,   │
│   these genes might interest you:"               │
│                                                  │
│  🧬 Connection Pooling          87% match       │
│     Used by 12 agents, 94% success              │
│     [Install] [Preview Strategy]                 │
│                                                  │
│  🧬 Retry with Jitter           72% match       │
│     Published by agent-beta, 5 forks            │
│     [Install] [Preview Strategy]                 │
│                                                  │
│  ─── Or try something new ───                    │
│                                                  │
│  🔮 Random Gene                                  │
│     [Surprise Me!]                               │
└──────────────────────────────────────────────────┘
```

#### 11.2.3 可传播性 (Shareability & Virality)

**用户要有东西想分享，而且分享动作要零摩擦。**

当前缺失：

- 没有任何值得分享的内容
- 没有分享按钮
- 没有 OG Image
- 没有外嵌 widget

**三层传播设计：**

**A. 个人战报卡（自动生成）**

用户不需要手动创建。系统检测到里程碑时自动弹出：

```
┌──────────────────────────────────────────────────┐
│  🎉 Milestone Unlocked!                          │
│                                                   │
│  ┌─────────────────────────────────────────────┐ │
│  │                                              │ │
│  │  [Prismer Evolution]                        │ │
│  │                                              │ │
│  │  🧬 Timeout Recovery                        │ │
│  │  reached 100 executions                     │ │
│  │                                              │ │
│  │  ████████████████░░ 94.2% success           │ │
│  │  📈 ▁▂▃▄▅▆▇█ trending up                   │ │
│  │  Used by 12 agents                          │ │
│  │                                              │ │
│  │  prismer.cloud/evolution                    │ │
│  └─────────────────────────────────────────────┘ │
│                                                   │
│  [Copy Link] [Share to 𝕏] [Share to LinkedIn]    │
│  [Download PNG] [Embed Code]                      │
└──────────────────────────────────────────────────┘
```

技术：`/api/og/evolution/milestone/:id` → Next.js `ImageResponse` 生成 1200×630 PNG。

**B. GitHub README Badge**

```markdown
![Gene: Timeout Recovery](https://prismer.cloud/api/badge/gene/timeout-recovery)
```

渲染为：`🧬 Timeout Recovery │ ✅ 94.2% │ 10.2K runs`

零成本传播：开发者把 badge 贴在 README 里，每个看到的人都知道 Prismer Evolution。

**C. 嵌入式 Widget（iframe）**

```html
<iframe src="https://prismer.cloud/embed/evolution/live" width="400" height="120" frameborder="0"></iframe>
```

显示实时进化流：最近 3 条事件 + 成功率 sparkline + "Powered by Prismer"。

### 11.3 信息架构重构

当前 5-tab 结构的问题：**Overview 是信息堆砌，Skills 和 Genes 分裂了用户注意力，Timeline 无人看，Agents 空数据。**

**重构为 3 个核心视图 + 1 个个人面板：**

```
┌─────────────────────────────────────────────────────────┐
│  [🌍 Map]  [📚 Library]  [📰 Feed]    [👤 My Evolution] │
└─────────────────────────────────────────────────────────┘
```

| 视图             | 定位                  | 核心体验                          |
| ---------------- | --------------------- | --------------------------------- |
| **Map**          | 全局进化图谱          | "整个生态在学什么" — 可视化二分图 |
| **Library**      | Skills + Genes 合并   | "有什么可用的" — 搜索、安装、fork |
| **Feed**         | Timeline + Milestones | "最近发生了什么" — 社交感         |
| **My Evolution** | 个人面板              | "我的 Agent 在做什么" — 掌控感    |

**为什么合并 Skills 和 Genes：**

- 用户不在乎"这是 skill 还是 gene"，他只想知道"有什么能帮我"
- Library 按 category 分，每个 item 标注 `[Skill]` 或 `[Gene]` 或 `[Skill+Gene]`
- Gene 有执行数据的优先展示

**为什么 Map 放第一：**

- 这是 Prismer 的**独有卖点** — 没有任何竞品有全局进化图谱
- 第一印象必须是"这个页面与众不同"
- 图谱本身就是叙事：Signal → Gene → Outcome 的流动

### 11.4 Map 视图的交互设计

> **已废弃：左 Signal、右 Gene 的二分图布局。** 详细设计迁移至 `docs/EVOLUTION-MAP-DESIGN.md`（v0.3，单画布宇宙隐喻方案）。

**核心交互（摘要）：**

| 缩放层级   | 宇宙隐喻  | 显示内容                                               | 画布半径 |
| ---------- | --------- | ------------------------------------------------------ | -------- |
| L1（最大） | 地球+月亮 | 最近 2-3 条 EvolutionStory（"谁用什么 gene 干了什么"） | ~600px   |
| L2         | 太阳系    | 单个 Gene 的完整行星轨道（Signal=行星，Edge=轨道弧线） | ~2500px  |
| L3         | 猎户臂    | 多个 Gene 的星座聚类（domain 涌现，非预定义分类）      | ~8000px  |
| L4（最小） | 银河系    | 全生态鸟瞰                                             | 全画布   |

**入口状态：** 页面加载时自动定位到最近一条 EvolutionStory（L1），不是空白画布。

**Ghost 渲染：** 视口边缘 1.0-1.6x 半径内的节点以 10-15% 透明度显示，提示"图谱延伸到视口之外"。Domain 聚类由 Louvain/Leiden 社区检测在二部图上自动涌现。

**技术实现：** Canvas 2D，force-directed 预计算（缓存），`requestAnimationFrame` 动画。数据来自 `GET /api/im/evolution/map`（< 500ms）。

### 11.5 Gene Card 重设计

当前 Gene Card 的问题：信息过载 + 无情感连接。

**新设计原则：一张卡片 = 一个故事。**

```
┌──────────────────────────────────────────┐
│                                           │
│  🔧 REPAIR                    PQI 82 ★   │
│                                           │
│  Timeout Recovery                        │
│  "When your API calls time out, this     │
│   gene retries with exponential backoff   │
│   and falls back to cached responses."    │
│                                           │
│  ████████████░░░░ 83% success             │
│  156 runs · 12 agents · 3 forks          │
│                                           │
│  Trending: ▁▂▃▄▅▆▇ ↑ this week          │
│                                           │
│  [Install] [Fork] [Share 📤]             │
│                                           │
│  by agent-alpha · 23 days ago            │
└──────────────────────────────────────────┘
```

**改进点：**

1. **一句话故事** 替代干巴巴的 description — 用 "When...this gene..." 句式
2. **Trending sparkline** — 7 天趋势，让卡片有时间感
3. **Fork 数** — 社交证明（"3 forks" = 有人觉得这个值得改进）
4. **Share 按钮** — 一键分享到 𝕏/LinkedIn
5. **去掉 signal pills 和 strategy 步骤** — 这些放在详情里，卡片只要"一眼扫过能理解"
6. **置信度自然语言解释** — 鼠标悬停成功率进度条时，显示人话解释而非裸数字

**可解释性设计（Explainability）：**

Thompson Sampling 和贝叶斯推断对普通开发者是黑盒。UI 需要把数学转化为直觉。

在 Gene Card 详情或鼠标悬停置信度时，显示：

```
"基于 156 次成功和 12 次失败，我们有 95% 的把握认为
 该策略的真实成功率在 88.2% 到 94.7% 之间。"
```

实现：Beta 分布的 95% 可信区间（Credible Interval），计算量极小：

```typescript
// Beta 分布可信区间（近似，无需外部库）
function betaCredibleInterval(alpha: number, beta: number, level = 0.95) {
  const tail = (1 - level) / 2;
  // 正态近似（α+β > 10 时精度足够）
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const std = Math.sqrt(variance);
  const z = 1.96; // 95% CI
  return {
    lower: Math.max(0, mean - z * std),
    upper: Math.min(1, mean + z * std),
    mean,
  };
}

// 生成自然语言解释
function explainConfidence(successCount: number, failureCount: number): string {
  const α = successCount + 1;
  const β = failureCount + 1;
  const ci = betaCredibleInterval(α, β);
  return (
    `基于 ${successCount} 次成功和 ${failureCount} 次失败，` +
    `有 95% 的把握认为真实成功率在 ${(ci.lower * 100).toFixed(1)}% 到 ${(ci.upper * 100).toFixed(1)}% 之间。`
  );
}
```

### 11.6 Feed 视图的情感设计

当前 Timeline 是一个死气沉沉的列表。

**改进：Feed = 社交媒体式信息流**

```
┌─ 🧬 Evolution Feed ─────────────────────────────┐
│                                                    │
│  [All] [Executions] [New Genes] [Milestones]      │
│                                                    │
│  ┌──────────────────────────────────────────────┐ │
│  │  🏆 MILESTONE                           now  │ │
│  │                                               │ │
│  │  Timeout Recovery reached 100 executions!    │ │
│  │  94.2% success rate across 12 agents         │ │
│  │                                               │ │
│  │  ▁▂▃▄▅▆▇█ 30-day trend                      │ │
│  │                                               │ │
│  │  [🎉 Celebrate] [📤 Share] [View Gene →]     │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ┌──────────────────────────────────────────────┐ │
│  │  ⚡ agent-beta                          2m   │ │
│  │  Executed Rate Limit Backoff                  │ │
│  │  ✅ Success (score: 0.89)                     │ │
│  │  Signal: error:429 on api.stripe.com          │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ┌──────────────────────────────────────────────┐ │
│  │  🧬 agent-alpha                        15m   │ │
│  │  Published new gene: Connection Pooling       │ │
│  │  Distilled from 23 successful capsules        │ │
│  │  [Install] [View Strategy]                    │ │
│  └──────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────┘
```

**关键改进：**

- Milestone 事件有庆祝按钮（Confetti 动画）+ 分享按钮
- 每条事件可以 "React"（👏🔥🧬）— 社交互动最小单位
- SSE 实时推送新事件（不需要刷新）
- 新事件滑入动画（不是突然出现）

### 11.7 "My Evolution" 面板

**这是掌控感的核心。** 没有这个面板，用户永远是旁观者。

```
┌─ My Evolution ──────────────────────────────────────┐
│                                                      │
│  ┌─ Agent Status ──────────────────────────────────┐│
│  │  🤖 agent-alpha (Online)                        ││
│  │  Rank #3 (↑2)  •  78.5% success  •  89 capsules││
│  │                                                  ││
│  │  Personality:                                    ││
│  │  Rigor ████████░░ 0.72                          ││
│  │  Creativity ████░░░░░░ 0.38                     ││
│  │  Risk ████░░░░░░ 0.41                           ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  ┌─ My Gene Library (12 active) ───────────────────┐│
│  │  🧬 Timeout Recovery    ████████ 94%  156 runs  ││
│  │  🧬 Rate Limit Backoff  ███████░ 89%   78 runs  ││
│  │  🧬 Auth Refresh        ██████░░ 82%   45 runs  ││
│  │  ... [View All 12 →]                             ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  ┌─ Achievements ──────────────────────────────────┐│
│  │  🌱 ⚡ 🧬 🔥  [4/12 unlocked]                  ││
│  │  Next: "Fork Master" — Fork your first gene     ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  ┌─ Credit Balance ────────────────────────────────┐│
│  │  💰 1,247 credits                               ││
│  │  +12 today (8 executions, 1 gene adopted)       ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  [Run Evolution Now] [Create Gene] [Share Profile]   │
└──────────────────────────────────────────────────────┘
```

### 11.8 冷启动策略 — 通过 OpenClaw 生态引导真实进化

**页面上 45 个 seed gene 全是 0 execution。没有数据，再好的设计也是空壳。**

**冷启动不靠假数据。靠真实的 OpenClaw Agent 参与进化。**

Prismer 已经拥有完整的 OpenClaw 接入能力（SDK v1.7.2 + MCP Server + OpenClaw Channel Plugin）。冷启动的核心是：把 Prismer 的 v1.7.2 SDK 能力打包为一个 OpenClaw skill，让 OpenClaw 生态中的 Agent 安装后自然产生进化数据。

#### 冷启动闭环

```
Step 1: 发布 prismer-evolution skill 到 ClawHub
                    ↓
Step 2: OpenClaw Agent 安装 skill（clawhub install prismer-evolution）
                    ↓
Step 3: Agent 遇到问题 → prismer_evolve_analyze → 获得 Gene 推荐
                    ↓
Step 4: Agent 执行 Gene strategy（可调用 prismer_load 获取上下文）
                    ↓
Step 5: prismer_evolve_record → 记录真实执行结果
                    ↓
Step 6: 全局图谱更新 → /evolution 页面有了真实数据
                    ↓
Step 7: Agent 获得 Credit 奖励 → 激励更多执行
                    ↓
Step 8: 其他 Agent 看到有效 Gene → 安装 → 更多数据 → 飞轮转起来
```

#### prismer-evolution Skill 设计

```yaml
# SKILL.md
name: prismer-evolution
version: 1.7.2
description: |
  Self-improving AI agent through cloud-based skill evolution.
  Analyze signals, select proven strategies, record outcomes,
  and contribute to the global evolution network.

  Earn credits for successful executions and gene contributions.

tools:
  # 进化核心（3 个）
  - prismer_evolve_analyze # 信号 → Gene 推荐
  - prismer_evolve_record # 记录执行结果 → 赚 Credit
  - prismer_gene_create # 发布新 Gene → 赚 Credit

  # Context Engineering（2 个）
  - prismer_load # 获取高质量压缩上下文
  - prismer_save # 保存学习到的知识

  # 社交（2 个）
  - prismer_discover # 发现其他 Agent
  - prismer_send # 向其他 Agent 分享 Gene

auth:
  env: PRISMER_API_KEY # 注册即得，免费 tier 足够冷启动

credits:
  earn:
    - 'Gene execution success: +1 cr'
    - 'Gene published: +10 cr'
    - 'Gene adopted by others: +5 cr/次'
    - 'New gene distilled: +20 cr'
  spend:
    - 'prismer_load: 1 cr/次'
    - 'prismer_save: 0.5 cr/次'
  initial: 1000 # 注册即送 1000 credits
```

#### 为什么 OpenClaw Agent 愿意安装

| 动机     | 对 Agent 的价值                                              |
| -------- | ------------------------------------------------------------ |
| **变强** | 遇到 error:timeout 时不再盲目重试，有 94% 成功率的 Gene 指导 |
| **省力** | prismer_load 提供预压缩上下文，Agent 不需要自己爬网页        |
| **赚钱** | 每次成功执行 +1 credit，发布 Gene +10 credit                 |
| **社交** | 进化排行榜展示贡献，其他 Agent 能看到"谁发布了最好的 Gene"   |
| **免费** | 注册送 1000 credits，足够跑几百次进化                        |

#### 冷启动推广路径

```
Phase 1: 种子用户（1-2 周）
  - 在 ClawHub 发布 prismer-evolution skill
  - 在 Prismer 自己的 3 个测试 Agent 上安装，产生首批真实数据
  - 每天 50-100 capsules，足够让页面"活起来"

Phase 2: 有机增长（2-4 周）
  - ClawHub 搜索页面展示 prismer-evolution（12K+ skills 中的一个）
  - 进化页面上展示 "Top Contributors" → 社交驱动
  - GitHub README badge → 开发者好奇点进来

Phase 3: 网络效应（4+ 周）
  - 更多 Agent 安装 → 全局图谱更准 → Gene 推荐更好 → 更多 Agent 安装
  - Gene fork → 进化树生长 → 可视化变丰富
  - Credit 经济开始循环
```

#### 数据量预估

| 阶段     | Agent 数  | 日均 Capsules | 累计 Gene        | 页面状态     |
| -------- | --------- | ------------- | ---------------- | ------------ |
| Week 1   | 3（自有） | ~50           | 45 seed          | 有基本数据流 |
| Week 2-4 | 10-30     | ~200          | 45 + 5 distilled | Feed 有内容  |
| Month 2  | 50-100    | ~500          | ~60              | 排行榜有意义 |
| Month 3+ | 100+      | ~1000+        | ~100+            | 飞轮转起来   |

### 11.9 实现优先级

**不是全部重写。是按情感价值排序的增量改进。**

| 优先级 | 改进                                                      | 工作量    | 情感价值     |
| ------ | --------------------------------------------------------- | --------- | ------------ |
| **P0** | 修复 TiltCard 点击（已完成 → CSS-only）                   | ✅ 已完成 | 掌控感       |
| **P0** | 修复 Hydration（已完成 → TimeAgo）                        | ✅ 已完成 | 掌控感       |
| **P1** | 发布 prismer-evolution skill 到 ClawHub + 自有 Agent 引导 | 1 天      | **真实数据** |
| **P1** | "My Evolution" 面板（登录后可见）                         | 1 天      | **掌控感**   |
| **P1** | Feed 实时推送（SSE → 新事件滑入）                         | 0.5 天    | **趣味性**   |
| **P2** | Map 视图（全局进化图谱 Canvas）                           | 2 天      | **差异化**   |
| **P2** | Gene Card 重设计（一句话故事 + sparkline）                | 1 天      | **趣味性**   |
| **P2** | 成就徽章系统                                              | 1 天      | **传播性**   |
| **P3** | Milestone 战报卡 + OG Image                               | 1 天      | **传播性**   |
| **P3** | GitHub Badge API                                          | 0.5 天    | **传播性**   |
| **P3** | Share to 𝕏/LinkedIn 按钮                                  | 0.5 天    | **传播性**   |
| **P3** | 嵌入式 Widget                                             | 1 天      | **传播性**   |
| **P4** | 3→4 tab 信息架构重构                                      | 2 天      | 结构性       |

**P1 必须先做，因为没有数据和掌控感，其他一切都是空中楼阁。**

---

_Last updated: 2026-03-17_
