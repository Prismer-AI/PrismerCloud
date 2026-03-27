# 智能体进化的未来：从"各自为战"到"集体智慧"

## 封面摘要
当数千个 AI Agent 同时在线，如何让它们从成功和失败中学习，形成可复用的策略知识？答案不是给每个 Agent 装个"大脑"，而是构建一个"集体进化网络"。

---

## 正文

### 开篇：每个 Agent 都在重复犯同样的错误

想象一下这个场景：

你部署了 100 个 AI Agent 来处理不同的任务。Agent A 遇到了 `error:500`，摸索了半天终于解决了。第二天，Agent B 遇到同样的 `error:500`，又从头开始摸索...

**问题来了：为什么 Agent B 不能直接"继承" Agent A 的经验？**

这就是当前 AI Agent 生态的痛点：**每个 Agent 都是孤岛，无法从其他 Agent 的成功中学习。**

但如果我们换个思路呢？如果有一个"进化引擎"，让所有 Agent 共享经验，从每次执行中学习，自动提炼可复用的策略——这就是我们今天要聊的**多 Agent 在线技能进化系统**。

### 一、进化不是"训练"，而是"在线学习"

很多人一听到"进化"，第一反应是：是不是要重新训练模型？

**不是。** 这里的进化发生在**策略层**，不是模型层。

#### 核心概念：Gene（基因）

Gene 不是代码，而是一个**可复用的策略模板**：

```json
{
  "name": "Timeout Recovery",
  "signals_match": ["error:timeout", "provider:openai"],
  "strategy": [
    "Step 1: 检查执行上下文，确定根因类别",
    "Step 2: 调用 prismer_recall 查找类似问题的历史解法",
    "Step 3: 根据诊断结果路由到专门的处理策略",
    "Step 4: 记录诊断结果（成功 = 正确路由，而非最终任务成功）"
  ]
}
```

当 Agent 遇到 `error:timeout` 时，系统会：
1. **匹配信号** → 找到相关的 Gene
2. **评估置信度** → 这个 Gene 在类似情况下成功率多少？
3. **推荐执行** → 把策略步骤传给 Agent
4. **记录结果** → 成功/失败反馈回系统，更新置信度

**关键点：** Gene 的 `strategy` 是自然语言步骤，Agent 在执行时会根据上下文动态调整。这就像给 Agent 一个"操作手册"，而不是硬编码的 if-else。

### 二、Thompson Sampling：让不确定性自己说话

如何选择"最好的" Gene？传统方法是取平均值：

```python
# 传统方法：Laplace 平滑
score = (success_count + 1) / (total_count + 2)
```

但这样有个问题：**新 Gene 和成熟 Gene 的置信度差异被平均掉了。**

更好的方法是 **Thompson Sampling**：不是取均值，而是从 Beta 分布中**采样**。

```python
# Thompson Sampling
for each gene:
    posterior = Beta(α, β)  # α = success+1, β = failure+1
    sample = posterior.sample()  # 从后验分布采样
    
gene* = argmax(sample)  # 选择采样值最高的
```

**为什么这样更好？**

- **高置信度 Gene**（α=100, β=10）：采样集中在 ~0.91，几乎总被选中
- **低置信度 Gene**（α=2, β=2）：采样分散在 0-1，有机会被探索
- **失败多的 Gene**（α=3, β=50）：采样集中在 ~0.06，几乎不被选

**自动实现 explore-exploit 平衡，无需手工调参。** 这是 Thompson Sampling 的核心优势。

### 三、层级贝叶斯：从"个体学习"到"种群学习"

单个 Agent 的经验有限，但如果 1000 个 Agent 都在学习呢？

**层级贝叶斯聚合**让新 Agent 可以"继承"全局经验：

```python
# 全局先验（所有 Agent 的经验池化）
α_global = Σ(all agents' success) + 1
β_global = Σ(all agents' failure) + 1

# Agent 本地经验
α_local = agent.success + 1
β_local = agent.failure + 1

# 加权融合（经验越多，越依赖本地）
n_agent = agent.total_executions
w = max(0.2, 1 - n_agent / 100)  # 新 Agent: w=0.9, 老 Agent: w=0.3

α_combined = α_global × w + α_local × (1 - w)
β_combined = β_global × w + β_local × (1 - w)
```

**效果：**
- 新 Agent 加入时，几乎完全依赖全局先验（w=0.9）
- 随着经验积累，逐渐转向本地经验
- **收敛速度从 O(√T) 提升到 O(√(T/M))**，M 个 Agent 线性加速

这就是"集体智慧"的数学表达。

### 四、Signal 层级标签：解决"开放空间"问题

这里有个陷阱：`error:500` 不是一个点，而是一个**开放空间**。

同样的错误码背后可能是：
- 数据库连接池耗尽
- 外部 API 抖动
- 内存溢出
- ...

如果把它们都折叠进同一个 edge，置信度就成了"无意义的平均数"。

**解决方案：Signal 层级标签**

```typescript
// 旧格式（错误）
signals: ["error:500"]

// 新格式（正确）
signals: [
  { type: "error:500", provider: "openai", stage: "api_call" },
  { type: "error:500", provider: "mysql", stage: "batch_write" }
]
```

**召回时按 tag 子集匹配，允许粗细度自动回退：**
- 精细匹配（1.0）：`{type:"error:500", provider:"openai", stage:"api_call"}` → 精确 Gene
- 粗粒度回退（0.3）：`{type:"error:500"}` → Diagnostic Gene（先诊断再路由）

**Diagnostic Gene** 是粗粒度信号的第一响应者，它不直接解决问题，而是：
1. 诊断根因类别（DB / Network / OOM / Logic）
2. 调用 `prismer_recall` 查找历史解法
3. 路由到专门的 Gene

**一个充分自适应的 Diagnostic Gene 让向量检索变得多余**——上下文感知发生在 Gene 执行层，架构更清晰。

### 五、Gene 蒸馏：从经验中提炼策略

系统如何"发现"新的 Gene？答案是**蒸馏**。

当某个 Agent 在同一信号下积累 ≥ 5 次无 Gene 指导的成功执行时，触发蒸馏：

```
成功 Capsule 收集
    ↓
LLM 分析共性规律
    ↓
生成 Draft Gene（策略模板）
    ↓
Critique 阶段（第二次 LLM 审查）
    - 是否足够通用？（不是 overfitting）
    - 是否比已有 Gene 有差异化？
    - strategy 步骤是否可执行？
    ↓
Canary 灰度发布（5% Agent 可见）
    ↓
验证通过 → Published（全局可见）
```

**成本控制：** 每次蒸馏需要 2 次 LLM 调用（~0.01 USD），每 Agent 每天最多 3 次。

### 六、安全机制：防止"坏经验"污染全局

进化系统最怕什么？**恶意或故障 Agent 刷数据，扭曲全局图谱。**

四层防御机制：

#### 1. Rate Decay（频率衰减）
短时间内的连续成功记录权重指数衰减：
```
第 1 次: Δα = 1.0
第 2 次: Δα = 0.5
第 3 次: Δα = 0.25
第 10 次: Δα ≈ 0.001（几乎无效）
```

#### 2. Canary 灰度
新 Gene 默认进入 `canary` 状态，仅限创建者 + 5% 随机 Agent 可见。

**晋升条件：**
- ≥3 个不同 Agent 使用
- ≥20 次执行
- 成功率 >50% 且 95% CI 下界 > 30%
- ≥48 小时观察窗口

#### 3. Circuit Breaker（熔断）
per-Gene 三态状态机：
```
CLOSED（正常） → 失败累积 → OPEN（拒绝执行）
    ↑                                    ↓
    └────────── cooldown 超时 ──────────┘
                    ↓
              HALF-OPEN（探测）
```

#### 4. Freeze Mode（冻结）
外部依赖（OpenAI、Exa）大面积宕机时，冻结所有 Beta 更新，防止级联故障污染长期积累的分布。

### 七、可观测性：看见进化正在发生

进化不是黑盒。系统提供完整的可观测性：

**全局指标：**
- Evolution Velocity：`capsules_7d / 7`（系统活跃度）
- Gene Diversity Index：`1 - Σ(share_i²)`（使用多样性）
- Exploration Rate：`unique_genes_7d / total_genes`（探索覆盖度）

**Gene 级指标：**
- PQI（综合质量）：`success_rate×0.4 + norm_exec×0.3 + adoption×0.2 + freshness×0.1`
- Bimodality Index：检测"伪精确 Confidence"（某些情景 100% 成功，另一些 100% 失败）

**可视化：** 全局进化图谱（Signal → Gene → Outcome 的流动）

### 八、与竞品的差异化

| 系统 | 定位 | 核心能力 |
|------|------|---------|
| **EvoMap** | 进化协议 | GEP 协议 + A2A 共享 |
| **PromptBreeder** | Prompt 优化 | 自参考进化（83.9% GSM8K） |
| **EvoAgentX** | 工作流优化 | TextGrad/AFlow/MIPRO |
| **CrewAI** | 认知记忆 | 层级范围树 + 自适应召回 |
| **Prismer** | **知识基础设施** | **Context 优化 + 在线进化** |

**Prismer 的独特价值：**
- **唯一将 Online RL 理论、Cloud 聚合、Context Engineering 三者结合的平台**
- 位于进化系统（优化行为）和编排框架（协调执行）之间的**知识层**
- Gene 的 strategy 原生支持 `prismer_load` 调用，动态获取上下文

### 九、未来方向

#### 1. 超图改造（Wolfram 框架）
用超图（Hypergraph）替代二部图，带来：
- **因果追踪**：任何 edge 的 α/β 可归因到具体 capsule 链
- **维度保真**：Signal 不再折叠到字符串，每个维度独立可查
- **分枝感知池化**：按策略相似度加权，而非全局均等

#### 2. MAP-Elites（质量-多样性）
同时优化质量（fitness）和多样性（behavior coverage），确保系统不会只有"简单修复" Gene，也有"复杂创新" Gene。

#### 3. 联邦学习（隐私保护）
跨 owner 共享时，使用差分隐私下的联邦学习（P-FCB），保护 Agent 隐私。

### 十、实践建议

如果你想在自己的系统中应用这些思路：

**最小闭环：**
1. 定义 Signal 格式（结构化标签）
2. 实现 Gene Store（策略模板库）
3. 选择算法（Thompson Sampling 或简化版 Laplace）
4. 结果记录（每次执行后更新置信度）

**进阶优化：**
1. 层级贝叶斯聚合（跨 Agent 共享）
2. Gene 蒸馏（自动发现新策略）
3. 安全机制（Rate Decay + Canary + Circuit Breaker）

**关键原则：**
- **可观测性优先**：算法可以换，但每个节点的状态必须可见
- **算法可插拔**：Gene 选择策略是接口，实现可以升级
- **Context 原生**：Gene 的 strategy 原生支持上下文获取

---

## 互动引导语

**看完这篇文章，你有什么想法？**

1. **你的 Agent 系统是否也遇到了"重复犯错"的问题？** 是如何解决的？
2. **Thompson Sampling vs 传统方法**：你在实际项目中用过 Thompson Sampling 吗？效果如何？
3. **Signal 层级标签**：你觉得还有哪些维度应该被纳入 Signal 标签？
4. **Gene 蒸馏**：如果让你设计一个 Gene 蒸馏系统，你会如何保证生成的质量？

**欢迎在评论区分享你的经验和观点！** 如果这篇文章对你有帮助，也欢迎转发给需要的朋友。

---

*本文基于 Prismer Evolution Engine 技术设计文档，更多技术细节可参考项目文档。*
