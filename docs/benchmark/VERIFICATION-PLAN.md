# Evolution Engine — 效果验证计划

> **Version:** 2.0
> **Date:** 2026-03-23
> **Status:** 待执行

---

## 1. 核心命题

**接入 Evolution Engine 后，coding agent 的任务完成质量可以被量化地证明有提升。**

"量化证明"意味着：

- A/B 对照实验
- 足够样本量 + 统计检验
- 不是"感觉有用"，是 p < 0.05

## 2. 从真实数据出发的 Task Set 设计

### 2.1 为什么不能自编 Task

之前的 Task Set 列了 "K8s Deploy Failure"、"OOM Recovery"、"DNS Resolution" 等场景。但测试环境真实数据显示：

- 23 个 capsule 中，信号只有 `error:timeout`(~80%) 和 `error:oom`(~20%)
- 没有任何 k8s、DNS、auth 场景的真实记录
- 14K skills 中大多数是 `general` category（代码编辑、搜索、文档），不是 ops/infra

自编 Task Set 会导致验证结论不可信——我们在验证系统对"想象中的场景"有效，而非对"实际使用的场景"有效。

### 2.2 Task Set 来源

**来源 1：ClawHub/skills.sh 热门 skill 的实际用途**

从 `im_skills` 表的 category 分布出发，按实际使用量排序：

| Category                      | Skills 数            | 代表性 task 场景                     |
| ----------------------------- | -------------------- | ------------------------------------ |
| general (14K)                 | 代码编辑、重构、解释 | "重构这个函数使其更可读"             |
| coding-agents-and-ides (1.2K) | IDE 配置、agent 协作 | "配置 Claude Code 的自定义 hook"     |
| web-and-frontend (933)        | React/Vue/CSS 开发   | "修复这个 responsive layout 的断裂"  |
| devops-and-cloud (408)        | CI/CD、部署、容器    | "GitHub Actions workflow 失败，修复" |
| search-and-research (352)     | 信息检索、总结       | "调研 X 技术的优缺点并给出建议"      |

**来源 2：真实 agent 错误日志**

收集 Claude Code / OpenCode 在 v1.7.2 上线后的真实失败场景（opt-in）：

- MCP tool 调用失败的 error message
- Agent 多次重试的 task 记录
- 用户反馈"agent 做错了"的 case

**来源 3：公开 benchmark**

| Benchmark | 描述                         | 适用                         |
| --------- | ---------------------------- | ---------------------------- |
| SWE-bench | GitHub issue → PR 的代码修复 | 直接用：code repair 场景     |
| HumanEval | 函数实现正确性               | 间接用：optimization 场景    |
| GAIA      | 通用 AI assistant 任务       | 间接用：multi-step reasoning |

### 2.3 最终 Task Set 结构

**不预定义固定 task list。采用两阶段设计：**

**阶段 1：采集（上线后 Day 1-7）**

```
部署 v1.7.2 到生产环境。
开启 capsule 记录（已实现）。
收集 7 天的真实 analyze/record 数据。
不做干预——观察 agent 自然使用 evolution 的行为。

采集内容：
  - 所有 evolve_analyze 调用的 signal + 返回的 gene + confidence
  - 所有 evolve_record 调用的 outcome + score + summary
  - 所有 unmatched signal（没有 gene 匹配的场景）
  - MCP tool 调用链路（哪些 tool 在 analyze 前后被调用）

产出：
  - Signal 频率分布（真实的 top-20 signal types）
  - Gene 命中率（analyze 返回 apply_gene 的比率）
  - Outcome 分布（success/failed ratio）
  - Unmatched rate（没有 gene 匹配的比率）
```

**阶段 2：构建 Task Set（Day 7-10）**

```
从阶段 1 的真实数据中：
  1. 取 top-10 最频繁的 signal types
  2. 对每个 signal type，选 5 个代表性 capsule
  3. 从 capsule 的 summary 还原出 task description
  4. 得到 50 个真实来源的 task

额外补充：
  5. 从 SWE-bench 选 25 个 code repair task（有 ground truth）
  6. 从 unmatched signals 选 25 个当前无法处理的 task（挑战场景）

总计：100 个 task，来源真实，覆盖：
  - 40% 已有 gene 可以处理的（验证 gene selection 准确率）
  - 35% 需要学习的（验证进化能力）
  - 25% 当前无 gene 的（验证 create_suggested + 人工反馈闭环）
```

## 3. A/B 实验设计

### 3.1 实验协议

```
对象: 同一个 Agent 实例（消除 LLM 能力差异）
控制变量: 相同的 LLM model、相同的 system prompt、相同的 tool set

实验组 (Evolution ON):
  - MCP Server 正常启用
  - Agent 可以调 evolve_analyze/record/create_gene
  - 进化图持续积累

对照组 (Evolution OFF):
  - MCP Server 中 evolve_* tools 被禁用（但其他 tools 如 context_load 保留）
  - Agent 纯依赖自己的 LLM 推理能力
  - 没有 gene 推荐，没有策略注入

分配方式:
  - 100 个 task 随机打乱
  - 每个 task 执行两次：一次 ON，一次 OFF
  - 顺序随机化（避免 LLM context 污染）
  - 每个 task 之间清空 agent 的对话上下文
```

### 3.2 关键问题：怎么判断"成功"

这是验证计划最难的部分。不同 task 的"成功"标准不同：

| Task 来源        | 成功判定            | 判定方式                    |
| ---------------- | ------------------- | --------------------------- |
| SWE-bench task   | PR 通过测试         | 自动化：`pytest` pass/fail  |
| Code repair task | 代码编译 + 测试通过 | 自动化：build + test        |
| 重构/优化 task   | 代码可读性提升      | **人工评判** (1-5 分，双盲) |
| 搜索/研究 task   | 信息准确性 + 完整性 | **人工评判**                |
| 配置/部署 task   | 操作正确执行        | 半自动：检查配置文件/log    |

**对于需要人工评判的 task，采用双盲评分：**

- 评判者不知道这个结果来自 ON 组还是 OFF 组
- 两个独立评判者打分
- Cohen's kappa > 0.6 才认为评判一致

### 3.3 度量指标

| 指标                            | 定义                           | 预期方向 |
| ------------------------------- | ------------------------------ | -------- |
| **Task Success Rate (TSR)**     | 成功完成的 task 占比           | ON > OFF |
| **First Attempt Success (FAS)** | 首次尝试就成功的比率           | ON > OFF |
| **Average Attempts (AA)**       | 完成 task 的平均尝试次数       | ON < OFF |
| **Average Quality Score (AQS)** | 人工评判的平均质量分 (1-5)     | ON > OFF |
| **Time to Completion (TTC)**    | 从 task 开始到完成的时间       | ON < OFF |
| **Gene Utilization Rate (GUR)** | Agent 实际使用推荐 gene 的比率 | 仅 ON 组 |

### 3.4 统计分析

```
主要假设检验:
  H0: TSR_on = TSR_off
  H1: TSR_on > TSR_off
  方法: McNemar's test（配对二分类数据，同一 task ON/OFF 比较）

效果量:
  Cohen's g = (discordant pairs 差值) / N
  g > 0.1: 小效果
  g > 0.3: 中效果
  g > 0.5: 大效果

次要分析:
  - 按 task 类别分组的 TSR 差异（哪类 task 获益最大）
  - 按 gene coverage 分层（有 gene 匹配 vs 无匹配的 task）
  - 时间效应（实验后期 vs 前期的 TSR 趋势——进化是否在加速）
```

## 4. 分平台验证

### 4.1 Claude Code

```
接入: MCP Server (npx -y @prismer/mcp-server)
特点: Agent 自主决定是否调用 evolution tools
关键观察:
  - Claude Code 是否主动调 evolve_analyze？（tool discovery）
  - 调了之后是否遵循推荐 strategy？（策略采纳率）
  - 多轮对话中是否在失败后调 evolve_record？（反馈闭环）
```

### 4.2 OpenCode

```
接入: TypeScript SDK
特点: 可以通过 SDK middleware 自动注入 evolution 调用
关键观察:
  - 自动注入 vs 手动调用的效果差异
  - offline mode 下的行为
```

### 4.3 OpenClaw

```
接入: Channel Plugin + Webhook
特点: evolution 调用在 plugin 层，agent 不感知
关键观察:
  - Plugin 注入 strategy 到 system prompt 的效果
  - Webhook 延迟对 outcome 记录准确性的影响
```

## 5. 判定标准

| 结论           | 条件                                      | 行动                                               |
| -------------- | ----------------------------------------- | -------------------------------------------------- |
| **有效**       | TSR lift > 10%, p < 0.05, Cohen's g > 0.3 | 发布 benchmark 报告                                |
| **有条件有效** | TSR lift 5-10%, p < 0.1                   | 分析哪些 task 类别有效，优化 signal 精度           |
| **无效**       | TSR lift < 5%, p > 0.1                    | 诊断失败原因——gene 质量？signal 匹配？策略采纳率？ |
| **有害**       | TSR lift < 0%                             | 立即检查 false positive 推荐是否误导 agent         |

## 6. 无效时的诊断流程

如果 A/B 实验结论是"无效"，按以下流程诊断：

```
Step 1: 检查 Gene Utilization Rate (GUR)
  GUR < 20% → Agent 没有使用推荐 → 问题在 tool discovery / prompt 设计
  GUR > 50% → Agent 使用了但没效果 → 进入 Step 2

Step 2: 检查 Gene Selection Accuracy
  对 ON 组中失败的 task：analyze 推荐的 gene 是否正确？
  人工标注 ground truth → 计算 precision
  Precision < 0.3 → 问题在 signal matching / Thompson Sampling
  Precision > 0.5 → 进入 Step 3

Step 3: 检查 Strategy Quality
  Gene 推荐正确，但 strategy 步骤不够具体？
  人工评估 strategy 的可执行性 (1-5 分)
  < 3 分 → 问题在 gene 内容质量 → 需要更好的 seed gene / distillation

Step 4: 检查 Agent 执行保真度
  Strategy 质量好，但 Agent 没按步骤做？
  对比 strategy 步骤 vs agent 实际操作 → 采纳率
  采纳率 < 30% → Agent LLM 忽略了推荐 → 需要更强的 prompt 注入方式
```

## 7. 时间线

```
Day 0:      v1.7.2 上线生产
Day 1-7:    阶段 1 — 被动采集真实数据（不干预）
Day 7-10:   阶段 2 — 从真实数据构建 Task Set
Day 10-12:  准备 A/B 实验基础设施（mock OFF group, 评判标准）
Day 12-20:  A/B 实验执行（3 平台）
Day 20-25:  数据分析 + 统计检验
Day 25-30:  结论 + 报告撰写（或无效诊断）
```

## 8. 输出

- `docs/benchmark/task-set.json` — 从真实数据构建的 Task Set
- `docs/benchmark/results-ab-experiment.json` — A/B 实验原始数据
- `docs/benchmark/results-statistical-analysis.md` — 统计分析报告
- 本文更新最终结论

_Last updated: 2026-03-23_
