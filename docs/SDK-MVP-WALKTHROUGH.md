# Evolution Engine v1.7.2 — MVP 验证与基准体系

> **Version:** 2.0
> **Date:** 2026-03-23
> **Status:** 待执行（v1.7.2 上线生产后启动）
> **前置:** 所有 v1.7.2 代码完成 + 测试环境 DB 对齐
> **输出:** docs/benchmark/ 系列验证报告

---

## 1. 问题域

v1.7.2 的 Evolution Engine 从设计到代码已完成，但还没有回答以下关键问题：

| #   | 问题                                                                         | 对应维度 |
| --- | ---------------------------------------------------------------------------- | -------- |
| 1   | 45 个 seed gene 和 17K skills 的召回有效吗？扩展到百万量级时呢？             | 规模     |
| 2   | selectGene + recordOutcome 的延迟、吞吐是否满足实时 Agent 调用？             | 性能     |
| 3   | 相比 evomap.ai，我们的 Gene Selection 质量、覆盖度、进化速度如何？           | 竞品对比 |
| 4   | 接入 Claude Code / OpenCode / OpenClaw 后，能证明 Agent 的任务成功率提升吗？ | 可验证性 |
| 5   | 冷启动阶段如何从 ClawHub + skills.sh 导入种子数据？                          | 冷启动   |
| 6   | 以上验证的详细计划、指标、脚本、预期结论                                     | 方法论   |

这些问题的验证计划分布在以下 benchmark 文档中：

---

## 2. 验证体系总览

```
docs/benchmark/
├── SCALE-ANALYSIS.md          — 规模分析：N 从 45 → 17K → 100K → 1M 的性能/召回曲线
├── PERFORMANCE-METRICS.md     — 性能评估：延迟、吞吐、学习收敛速度、诊断指标
├── COMPETITIVE-BENCHMARK.md   — 竞品对标：vs evomap.ai 的 8 维度量化对比
├── VERIFICATION-PLAN.md       — 效果验证：Agent 接入前后的量化提升证明（A/B 实验）
├── COLD-START-STRATEGY.md     — 冷启动策略：ClawHub + skills.sh 数据导入管道
├── SDK-DESIGN-REVIEW.md       — SDK 设计评审：从薄层到 EvolutionRuntime 抽象
├── SDK-REGRESSION.md          — SDK 回归测试：L0-L4 五层测试 + 覆盖度矩阵
├── IM-PERFORMANCE.md          — [已有] IM 服务器性能基准
└── results.json               — [已有] IM 基准原始数据
```

---

## 3. MVP 端到端链路（Agent A → Agent B 知识传递）

### 3.1 链路描述

```
Agent A (Claude Code + MCP)              Agent B (OpenCode + SDK)
━━━━━━━━━━━━━━━━━━━━━━━━━━              ━━━━━━━━━━━━━━━━━━━━━━━
T1: 接到 Task Y (k8s deploy 失败)
T2: evolve_analyze → seed gene 推荐 (低 confidence)
T3: 执行 → 失败
T4: evolve_record(outcome=failed)
T5: 人类提示正确做法
T6: evolve_create_gene("K8s OOM Recovery")
T7: 执行 → 成功
T8: evolve_record(outcome=success)
T9: evolve_publish(geneId, skipCanary=true)
                                         T10: 接到 Task Y
                                         T11: evolve_analyze → 命中 Agent A 的 gene
                                              (coverage=1.0, confidence>0.6)
                                         T12: 按 strategy 执行 → 一次成功
                                         T13: evolve_record(outcome=success)
```

### 3.2 当前实现状态

| 步骤 | 需要的能力                              | v1.7.2 状态          |
| ---- | --------------------------------------- | -------------------- |
| T2   | MCP evolve_analyze + SignalTag[]        | ✅ 已支持            |
| T4   | MCP evolve_record + scope               | ✅ 已支持            |
| T6   | MCP evolve_create_gene                  | ✅ 已有              |
| T8   | recordOutcome + scope isolation         | ✅ owner-only stats  |
| T9   | publishGene + skipCanary                | ✅ 已实现            |
| T11  | selectGene + global prior + cross-agent | ✅ Thompson sampling |
| T13  | scope-filtered recording                | ✅ 已实现            |

**v1.7.2 代码层面无断点。** 所有 MVP 链路环节均已实现。

### 3.3 验证方法

MVP demo 验证脚本：`scripts/test-evolution-mvp.ts`（待编写）

```
输入: 2 个 Agent，1 个 Task
预期: Agent B 在 Agent A publish gene 后，analyze 返回该 gene，confidence > 0.5
度量:
  - T2→T8 耗时（Agent A 学习周期）
  - T11 返回的 gene 是否正确
  - T12 成功率 vs 不使用 evolution 的成功率
```

---

## 4. 六维度验证框架

### 维度 1: 规模 → [`docs/benchmark/SCALE-ANALYSIS.md`](./benchmark/SCALE-ANALYSIS.md)

**核心问题：** selectGene() 在 N = {45, 1K, 10K, 100K, 1M} 个 gene 时的行为。

关注点：

- SQL 查询延迟随 N 的增长曲线
- Thompson sampling 在大候选池中的收敛速度
- Jaccard 信号匹配的碰撞率（N 大时 false positive）
- 倒排索引 vs 全表扫描的性能转折点
- 分片策略（scope + category 双维度分区）

### 维度 2: 性能 → [`docs/benchmark/PERFORMANCE-METRICS.md`](./benchmark/PERFORMANCE-METRICS.md)

**核心问题：** 工程延迟是否满足实时 Agent 调用？学习收敛速度是否符合理论预期？

关注点：

- selectGene P50/P95/P99 延迟（当前 ~30ms from IM benchmark）
- recordOutcome 写入吞吐
- Thompson sampling 收敛速度 vs 理论 regret bound O(√(KT log T))
- 不收敛时的诊断：信号不完备？分布漂移？样本不足？（这些是可修复的工程问题，不是理论极限）
- 北极星指标（SSR, RP, RegP, GD, ER）的阶段性目标

### 维度 3: 竞品对比 → [`docs/benchmark/COMPETITIVE-BENCHMARK.md`](./benchmark/COMPETITIVE-BENCHMARK.md)

**核心问题：** 如何量化证明比 evomap.ai 好？

对比维度：

1. Gene Selection 准确率（给定 signal，推荐的 gene 是否最优）
2. 进化收敛速度（从首次失败到稳定高成功率的 capsule 数）
3. 跨 Agent 知识传递效率（Agent A→B 的 latency + hit rate）
4. 冷启动性能（零数据到可用的时间）
5. Scale（支持的 gene/agent/capsule 量级）
6. 安全性（scope isolation, encryption, ACL）
7. 生态集成（支持的 Agent 平台数量）
8. 可观测性（metrics, dashboard, A/B experiment）

### 维度 4: 可验证性 → [`docs/benchmark/VERIFICATION-PLAN.md`](./benchmark/VERIFICATION-PLAN.md)

**核心问题：** 接入 evolution 前后，Agent 的哪些指标提升了？提升多少？

验证矩阵：

| Agent 平台  | 接入方式               | 度量指标                              |
| ----------- | ---------------------- | ------------------------------------- |
| Claude Code | MCP Server (17 tools)  | Task 成功率, 平均重试次数, 首次成功率 |
| OpenCode    | SDK (TypeScript)       | 同上 + offline 指标                   |
| OpenClaw    | Channel Plugin + Tools | 同上 + webhook 交互指标               |

实验设计：

- A/B 对照：相同 task set，一半 agent 开 evolution，一半关
- 统计显著性：>100 tasks, p < 0.05
- 效果量：Cohen's d > 0.3 才算有意义

### 维度 5: 冷启动 → [`docs/benchmark/COLD-START-STRATEGY.md`](./benchmark/COLD-START-STRATEGY.md)

**核心问题：** 系统上线时 gene 库是空的（只有 45 个 seed），怎么快速达到有效密度？

数据源：

- ClawHub (clawhub.ai): ~17K skills，有 downloads/stars 指标
- skills.sh: ~89K skills，有 weekly installs 指标
- Prismer 自有 seed genes: 45 个

导入策略：

1. 批量导入 top skills → 转化为 gene
2. LLM 辅助 signal_match 提取（从 SKILL.md 内容推断信号匹配模式）
3. 初始 edge 构建（seed prior from download/install 数据）
4. 质量门控（PQI > 阈值才入库）

### 维度 6: 方法论 → 贯穿以上所有文档

每个 benchmark 文档包含：

- 实验设计（输入/输出/对照）
- 数据收集脚本路径（`scripts/benchmark-*`）
- 预期结论范围
- 判定标准（pass/fail threshold）
- 时间线（何时执行，多长周期）

---

## 5. 执行计划

```
Phase 0: 代码就绪 ✅
  v1.7.2 全部功能完成 + 测试环境对齐

Phase 1: 上线生产 (Day 0)
  打 k8s-prod tag → MySQL 迁移 → 部署

Phase 2: 冷启动数据导入 (Day 1-3)
  ClawHub top 1000 skills → gene 转化
  skills.sh top 500 skills → gene 转化
  验证: gene 库 > 1500, seed prior 有效

Phase 3: MVP 端到端验证 (Day 3-5)
  跑 Agent A → Agent B 完整链路
  记录所有延迟、命中率、confidence
  输出: docs/benchmark/results-mvp.json

Phase 4: 规模测试 (Day 5-10)
  从 1.5K gene 扩展到 10K → 100K (合成数据)
  记录 selectGene 延迟曲线
  输出: docs/benchmark/results-scale.json

Phase 5: 竞品对标 (Day 10-15)
  在相同 task set 上跑 Prismer vs EvoMap (如果可访问)
  或用 EvoMap 公开数据推算对比
  输出: docs/benchmark/COMPETITIVE-BENCHMARK.md 更新

Phase 6: A/B 效果验证 (Day 15-30)
  100+ tasks, evolution on/off 对照
  统计分析: 成功率 lift, p-value, effect size
  输出: docs/benchmark/VERIFICATION-PLAN.md 更新 + 结论
```

---

## 6. 关联文档

| 文档                                     | 内容                             | 与本文关系            |
| ---------------------------------------- | -------------------------------- | --------------------- |
| `docs/evolution/ENGINE.md`               | Evolution Engine 技术设计 v0.3.0 | 被验证的系统          |
| `docs/evolution/THEORETICAL-REVIEW.md`   | 计算不可约性分析                 | 性能维度的理论基础    |
| `docs/evolution/EVOMAP-ANALYSIS.md`      | EvoMap 竞品分析                  | 竞品维度的输入        |
| `docs/evolution/SKILL-GENE-ECOSYSTEM.md` | Skill/Gene 生态设计              | 冷启动维度的输入      |
| `docs/im/SECURITY-IMPROVEMENT-PLAN.md`   | 安全改进计划                     | scope/encryption 验证 |
| `docs/benchmark/IM-PERFORMANCE.md`       | IM 性能基准                      | 性能维度的基线参考    |

_Last updated: 2026-03-23_
